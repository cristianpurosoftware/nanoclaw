// Scope Dial to the chosen agents through the OneCLI v2 policy API.
//
// OneCLI gateway 1.42 enforces the first-match policy engine (`/v1/policy`)
// and rejects legacy rule writes with 410, so the per-agent block rules the
// skill used to write cannot be created any more. The pinned CLI (2.2.5) has no
// policy commands, so this script talks to the HTTP API of the gateway the CLI
// is configured for, with the key the CLI itself uses (`onecli auth api-key`),
// the way add-onecli's provider-credentials script does for secrets.
//
// The policy it keeps is one BLOCK rule, "Dial: blocked agents", on the host
// api.getdial.ai whose identities are every NanoClaw agent that was not chosen
// (the same thing the legacy per-agent block rules expressed). Block rules
// fail closed: OneCLI cascade-deletes a rule's identities with the agent, and
// a block left with no identities blocks EVERY agent, whereas an allow rule
// in that state would open Dial to every agent. So no allow rule is written,
// and `all` means no rule at all. The rule is deleted and recreated on every
// run, together with any rule a legacy per-agent block was migrated to
// ("Dial: blocked for <group>"), and the draft is published. Agents the rule
// already blocked that are not this install's groups (another NanoClaw on
// the same gateway) stay blocked. An operator's own rules are never touched;
// since they sit earlier in the order and win first-match, an operator allow
// on the Dial host stops the run instead of silently losing to it.
//
// Usage (from the NanoClaw repo root):
//   pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts scope --agents <all|none|ag-1,ag-2>
//   pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts remove

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DIAL_HOST = 'api.getdial.ai';
export const BLOCK_RULE = 'Dial: blocked agents';
/** The legacy per-agent block rules migrate under their own names. */
const LEGACY_BLOCK_PREFIX = 'Dial: blocked for ';
/** OneCLI caps identities per rule; more blocked agents take more rules. */
const IDENTITIES_PER_RULE = 100;

export interface PolicyIdentity {
  type: string;
  id: string;
}
export interface PolicyTarget {
  kind: string;
  hostPattern?: string | null;
  pathPattern?: string | null;
  method?: string | null;
  secretId?: string | null;
  secretScope?: string | null;
}
export interface PolicyRule {
  id: string;
  logicalId: string;
  source: string;
  name: string;
  action: string;
  enabled: boolean;
  priority: number;
  identities: PolicyIdentity[];
  targets: PolicyTarget[];
}
export interface OneCliAgent {
  id: string;
  identifier: string;
  name: string;
}
export interface AgentGroup {
  id: string;
  name: string;
}

export interface PolicyClient {
  listAgents(): Promise<OneCliAgent[]>;
  /** Vault metadata only (ids, names, hosts): never values. */
  listSecrets(): Promise<Array<{ id: string; name: string; hostPattern: string }>>;
  listRules(status: 'draft' | 'published'): Promise<PolicyRule[]>;
  createRule(body: unknown): Promise<PolicyRule>;
  deleteRule(id: string): Promise<void>;
  publish(): Promise<void>;
}

export class PolicyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The gateway's `{ error: { message } }` envelope, or a status-only message. */
async function errorMessage(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const err = isRecord(body) ? body.error : undefined;
  const text = isRecord(err) && typeof err.message === 'string' ? err.message : typeof err === 'string' ? err : '';
  return text ? `${response.status}: ${text}` : `HTTP ${response.status}`;
}

export function createPolicyClient(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): PolicyClient {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('the OneCLI api-host must be an HTTP(S) URL without credentials, query, or fragment');
  }
  const root = base.href.replace(/\/+$/, '');
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch (e) {
      throw new Error(`could not reach the OneCLI gateway at ${root}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!response.ok)
      throw new PolicyApiError(response.status, `${method} ${path} failed with ${await errorMessage(response)}`);
    if (response.status === 204) return undefined;
    return response.json();
  };
  const list = async (path: string, what: string): Promise<unknown[]> => {
    const payload = await request('GET', path);
    if (!Array.isArray(payload)) throw new Error(`OneCLI returned an unexpected ${what} payload`);
    return payload;
  };
  return {
    listAgents: async () =>
      (await list('/v1/agents', 'agent list')).map((a) => {
        if (!isRecord(a) || typeof a.id !== 'string' || typeof a.identifier !== 'string') {
          throw new Error('OneCLI returned an unexpected agent entry');
        }
        return { id: a.id, identifier: a.identifier, name: typeof a.name === 'string' ? a.name : a.identifier };
      }),
    listSecrets: async () =>
      (await list('/v1/secrets', 'secret list')).map((s) => ({
        id: isRecord(s) && typeof s.id === 'string' ? s.id : '',
        name: isRecord(s) && typeof s.name === 'string' ? s.name : '',
        hostPattern: isRecord(s) && typeof s.hostPattern === 'string' ? s.hostPattern : '',
      })),
    listRules: async (status) =>
      (await list(`/v1/policy/rules?status=${status}`, 'policy rule list')).map((r) => {
        if (!isRecord(r) || typeof r.id !== 'string' || typeof r.name !== 'string') {
          throw new Error('OneCLI returned an unexpected policy rule');
        }
        return r as unknown as PolicyRule;
      }),
    createRule: async (body) => (await request('POST', '/v1/policy/rules', body)) as PolicyRule,
    deleteRule: async (id) => {
      await request('DELETE', `/v1/policy/rules/${encodeURIComponent(id)}`);
    },
    publish: async () => {
      await request('POST', '/v1/policy/publish');
    },
  };
}

const wholeDialHost = (rule: PolicyRule): boolean =>
  rule.targets.length === 1 &&
  rule.targets[0].kind === 'network' &&
  rule.targets[0].hostPattern === DIAL_HOST &&
  !rule.targets[0].pathPattern &&
  !rule.targets[0].method;

/** This skill's rules: its block, or a migrated legacy per-agent block, on the whole Dial host. */
export const isDialRule = (rule: PolicyRule): boolean =>
  rule.action === 'block' &&
  wholeDialHost(rule) &&
  (rule.name === BLOCK_RULE ||
    (rule.name.startsWith(LEGACY_BLOCK_PREFIX) && rule.name.length > LEGACY_BLOCK_PREFIX.length));

const hostPatternCoversDial = (pattern: string): boolean => {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern.toLowerCase() === DIAL_HOST;
  const prefix = pattern.slice(0, star).toLowerCase();
  const suffix = pattern.slice(star + 1).toLowerCase();
  return (
    DIAL_HOST.length >= prefix.length + suffix.length && DIAL_HOST.startsWith(prefix) && DIAL_HOST.endsWith(suffix)
  );
};

/**
 * An operator allow that reaches the Dial host; ahead of our block it wins. A
 * secret target permits the hosts of the secrets it names: every project
 * secret for a scope target (the Dial key included, once it exists), or the
 * one secret for an id target. Bridge-derived equipment rows are injection
 * only and never decide, so only custom rules count.
 */
const foreignAllowOnDial = (rule: PolicyRule, dialSecretIds: Set<string>): boolean =>
  rule.source === 'custom' &&
  !isDialRule(rule) &&
  rule.enabled &&
  rule.action === 'allow' &&
  rule.targets.some((t) => {
    if (t.kind === 'network') return !!t.hostPattern && hostPatternCoversDial(t.hostPattern);
    if (t.kind === 'secret') return !!t.secretScope || (!!t.secretId && dialSecretIds.has(t.secretId));
    return false;
  });

export type DialScope = { kind: 'all' } | { kind: 'none' } | { kind: 'ids'; ids: string[] };

export function parseScope(raw: string): DialScope {
  const words = [
    ...new Set(
      raw
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ];
  if (words.length === 1 && words[0] === 'all') return { kind: 'all' };
  if (words.length === 1 && words[0] === 'none') return { kind: 'none' };
  if (words.length && words.every((w) => /^ag-[A-Za-z0-9-]+$/.test(w))) return { kind: 'ids', ids: words };
  throw new Error(`invalid agent selection '${raw}': use agent ids separated by commas, all, or none`);
}

/** Delete every Dial rule in the draft; returns how many went. */
async function deleteDialRules(client: PolicyClient): Promise<number> {
  const mine = (await client.listRules('draft')).filter(isDialRule);
  for (const rule of mine) await client.deleteRule(rule.id);
  return mine.length;
}

export interface ScopeOutcome {
  allowed: AgentGroup[];
  blocked: AgentGroup[];
}

/** Reconcile the Dial policy to `scope` and publish it. */
export async function scopeDial(client: PolicyClient, scope: DialScope, groups: AgentGroup[]): Promise<ScopeOutcome> {
  const agents = await client.listAgents();
  const agentOf = new Map(agents.map((a) => [a.identifier, a]));
  for (const g of groups) {
    if (!agentOf.has(g.id))
      throw new Error(`no OneCLI agent for ${g.name} (${g.id}) — the agent creation step did not run`);
  }
  if (scope.kind === 'ids') {
    const known = new Set(groups.map((g) => g.id));
    for (const id of scope.ids)
      if (!known.has(id)) throw new Error(`unknown agent group '${id}' — see: ncl groups list`);
  }
  const chosen =
    scope.kind === 'all' ? groups : scope.kind === 'none' ? [] : groups.filter((g) => scope.ids.includes(g.id));
  const blocked = groups.filter((g) => !chosen.some((c) => c.id === g.id));
  const ours = new Set(groups.map((g) => agentOf.get(g.id)!.id));

  const draft = await client.listRules('draft');
  const published = await client.listRules('published');
  // First-match: an operator's allow on the Dial host sits ahead of our block
  // and would win. Stop before writing anything rather than publish a block
  // that does not block.
  const dialSecretIds = new Set(
    (await client.listSecrets()).filter((x) => hostPatternCoversDial(x.hostPattern)).map((x) => x.id),
  );
  const ahead = draft.filter((r) => foreignAllowOnDial(r, dialSecretIds)).map((r) => `"${r.name}"`);
  if (ahead.length) {
    throw new Error(
      `the OneCLI policy rule ${ahead.join(', ')} allows ${DIAL_HOST} ahead of the Dial block, so the block would not apply. Remove it or make it narrower in the OneCLI console, then re-run.`,
    );
  }
  // Agents another NanoClaw install on this gateway blocked stay blocked: only
  // this install's groups are reconciled (the legacy per-agent rules behaved
  // the same way). The published set counts too, so a run interrupted after
  // the delete does not lose them on retry. Identities of deleted agents are
  // already gone.
  const foreignBlocked = [...draft, ...published]
    .filter(isDialRule)
    .flatMap((r) => r.identities.filter((i) => i.type === 'agent' && !ours.has(i.id)).map((i) => i.id));
  const blockedAgentIds = [...new Set([...foreignBlocked, ...blocked.map((g) => agentOf.get(g.id)!.id)])];
  await deleteDialRules(client);
  // No agent left out (`all`, or every group named) needs no rule. `none`
  // before any group exists blocks every agent (no identities = any agent)
  // until a group exists and the skill is re-run.
  const chunks: string[][] = [];
  for (let i = 0; i < blockedAgentIds.length; i += IDENTITIES_PER_RULE) {
    chunks.push(blockedAgentIds.slice(i, i + IDENTITIES_PER_RULE));
  }
  const blockEveryone = scope.kind === 'none' && groups.length === 0;
  if (blockEveryone) chunks.push([]);
  for (const ids of chunks) {
    await client.createRule({
      name: BLOCK_RULE,
      description:
        'Managed by NanoClaw /add-dial-tool: the agents that may not use Dial. Re-run the skill to change it.',
      action: 'block',
      identities: ids.map((id) => ({ type: 'agent', id })),
      targets: [{ kind: 'network', hostPattern: DIAL_HOST }],
    });
  }
  await client.publish();

  // Read the active generation back: the block must be live with exactly the
  // agents that were not chosen.
  const live = await client.listRules('published');
  const mine = live.filter(isDialRule);
  const liveIds = mine.flatMap((r) => r.identities.filter((i) => i.type === 'agent').map((i) => i.id)).sort();
  if (mine.some((r) => !r.enabled || r.name !== BLOCK_RULE)) {
    throw new Error('the published OneCLI policy still carries a stale or disabled Dial rule');
  }
  if (liveIds.join('\n') !== [...blockedAgentIds].sort().join('\n')) {
    throw new Error('the published OneCLI policy does not block exactly the agents that were not chosen');
  }
  // An identity-less block is "every agent": only ever intended for `none`
  // before the first group; anywhere else it would cut the chosen agents off.
  if (
    mine.some((r) => r.identities.length === 0) !== blockEveryone ||
    (!blockEveryone && mine.length !== chunks.length)
  ) {
    throw new Error('the published OneCLI policy blocks a different set of agents than intended');
  }
  return { allowed: chosen, blocked };
}

/**
 * Delete this skill's rules (and migrated legacy ones) and publish. Refuses
 * while a Dial secret is still in the vault: the block is what keeps unchosen
 * agents away from a key that is injected for every `all`-mode agent.
 */
export async function removeDial(client: PolicyClient): Promise<number> {
  const assertNoDialSecret = async () => {
    const dialSecret = (await client.listSecrets()).find((s) => s.hostPattern === DIAL_HOST || /dial/i.test(s.name));
    if (dialSecret) {
      throw new Error(
        `the OneCLI vault still holds a Dial secret (${dialSecret.name}); delete it first, then remove the policy`,
      );
    }
  };
  await assertNoDialSecret();
  const draft = await deleteDialRules(client);
  const live = (await client.listRules('published')).filter(isDialRule).length;
  if (draft || live) {
    // Re-check right before going live: a key written meanwhile would
    // otherwise go unblocked.
    await assertNoDialSecret();
    await client.publish();
  }
  return draft;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const run = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The gateway the onecli CLI writes to, and the key it authenticates with. */
export function cliConnection(): { url: string; apiKey: string } {
  let url = '';
  try {
    const parsed: unknown = JSON.parse(run('onecli', ['config', 'get', 'api-host']));
    if (isRecord(parsed) && typeof parsed.value === 'string') url = parsed.value.trim();
  } catch {
    url = '';
  }
  if (!url) throw new Error("could not read the onecli CLI's api-host, so the OneCLI gateway is unknown");
  // A gateway with ambient local auth needs no key; the CLI then fails here
  // and the requests go without one.
  let apiKey = '';
  try {
    const parsed: unknown = JSON.parse(run('onecli', ['auth', 'api-key']));
    if (isRecord(parsed) && typeof parsed.apiKey === 'string') apiKey = parsed.apiKey.trim();
  } catch {
    apiKey = '';
  }
  return { url, apiKey };
}

function agentGroups(): AgentGroup[] {
  let payload: unknown;
  try {
    payload = JSON.parse(run('ncl', ['groups', 'list', '--json']));
  } catch {
    throw new Error('could not list agent groups — is the NanoClaw host running?');
  }
  const data = isRecord(payload) ? payload.data : undefined;
  if (!Array.isArray(data)) throw new Error('ncl groups list returned an unexpected payload');
  return data.map((g) => {
    if (!isRecord(g) || typeof g.id !== 'string') throw new Error('ncl groups list returned an unexpected group');
    return { id: g.id, name: typeof g.name === 'string' ? g.name : g.id };
  });
}

function explain(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof PolicyApiError && e.status === 401) {
    return `${msg}. The OneCLI gateway rejected the CLI's key: run onecli auth login, then re-run.`;
  }
  if (e instanceof PolicyApiError && e.status === 403 && /editing is not enabled/i.test(msg)) {
    return `${msg}. This gateway does not enforce the policy engine (OneCLI gateway 1.42 does); upgrade to the pinned 1.42.0 (docs/onecli-upgrades.md).`;
  }
  return msg;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'scope') {
      const at = rest.indexOf('--agents');
      if (at < 0 || !rest[at + 1]) throw new Error('usage: dial-policy.ts scope --agents <all|none|ag-1,ag-2>');
      const scope = parseScope(rest[at + 1]);
      const { url, apiKey } = cliConnection();
      const outcome = await scopeDial(createPolicyClient(url, apiKey), scope, agentGroups());
      // stdout is captured by the skill and interpolated into later steps, so
      // it carries ids only (validated as `ag-…`), never a free-text name.
      for (const g of outcome.allowed) console.log(`allowed:${g.id}`);
      for (const g of outcome.blocked) console.log(`blocked:${g.id}`);
      console.log('published');
      for (const g of outcome.allowed) console.error(`allowed: ${g.name} (${g.id})`);
      for (const g of outcome.blocked) console.error(`blocked: ${g.name} (${g.id})`);
      return 0;
    }
    if (command === 'remove') {
      const { url, apiKey } = cliConnection();
      const gone = await removeDial(createPolicyClient(url, apiKey));
      console.log(gone ? `removed ${gone} Dial policy rule(s) and published` : 'no Dial policy rules to remove');
      return 0;
    }
    throw new Error('usage: dial-policy.ts <scope --agents …|remove>');
  } catch (e) {
    console.error(explain(e));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
