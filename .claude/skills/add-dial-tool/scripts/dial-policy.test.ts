import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BLOCK_RULE,
  DIAL_HOST,
  PolicyApiError,
  createPolicyClient,
  isDialRule,
  parseScope,
  removeDial,
  scopeDial,
  unpublishedChanges,
  type OneCliAgent,
  type PolicyClient,
  type PolicyRule,
} from './dial-policy.js';

const GROUPS = [
  { id: 'ag-sales', name: 'Sales' },
  { id: 'ag-support', name: 'Support' },
];
const AGENTS: OneCliAgent[] = [
  { id: 'oc-default', identifier: 'default', name: 'Default Agent' },
  { id: 'oc-sales', identifier: 'ag-sales', name: 'Sales' },
  { id: 'oc-support', identifier: 'ag-support', name: 'Support' },
];
const rule = (over: Partial<PolicyRule>): PolicyRule => ({
  id: 'r',
  logicalId: 'l',
  source: 'custom',
  name: BLOCK_RULE,
  action: 'block',
  enabled: true,
  priority: 1,
  identities: [],
  targets: [{ kind: 'network', hostPattern: DIAL_HOST, pathPattern: null, method: null }],
  ...over,
});
const ids = (r: PolicyRule) => r.identities.map((i) => i.id);

/**
 * An in-memory gateway with the semantics the script relies on: a draft the
 * writes land in, a publish that snapshots it, rules appended at max+1.
 */
class FakeGateway implements PolicyClient {
  draft: PolicyRule[] = [];
  published: PolicyRule[] = [];
  secrets: Array<{ id: string; name: string; hostPattern: string }> = [];
  defaults = { draft: 'allow', published: 'allow' };
  calls: string[] = [];
  private seq = 0;
  constructor(
    private agents: OneCliAgent[] = AGENTS,
    draft: PolicyRule[] = [],
  ) {
    this.draft = draft.map((r) => ({ ...r }));
    this.published = draft.map((r) => ({ ...r }));
  }
  async listAgents() {
    this.calls.push('agents');
    return this.agents;
  }
  async listSecrets() {
    this.calls.push('secrets');
    return this.secrets;
  }
  async listRules(status: 'draft' | 'published') {
    this.calls.push(`list ${status}`);
    return (status === 'draft' ? this.draft : this.published).map((r) => ({ ...r }));
  }
  async defaultAction(status: 'draft' | 'published') {
    return this.defaults[status];
  }
  async createRule(body: unknown) {
    const b = body as Partial<PolicyRule>;
    const priority = Math.max(0, ...this.draft.map((r) => r.priority)) + 1;
    const created = rule({
      id: `r${++this.seq}`,
      logicalId: `l${this.seq}`,
      name: b.name!,
      action: b.action!,
      identities: b.identities ?? [],
      targets: b.targets ?? [],
      priority,
    });
    this.draft.push(created);
    this.calls.push(`create ${created.name} ${created.action} [${ids(created).join(',')}]`);
    return created;
  }
  async deleteRule(id: string) {
    this.calls.push(`delete ${id}`);
    this.draft = this.draft.filter((r) => r.id !== id);
  }
  async publish() {
    this.calls.push('publish');
    this.published = this.draft.map((r) => ({ ...r }));
  }
}

const liveDial = (gw: FakeGateway) => gw.published.filter(isDialRule).sort((a, b) => a.priority - b.priority);

describe('dial-policy: scoping through the v2 policy API', () => {
  it('blocks exactly the agents that were not chosen, then publishes', async () => {
    const gw = new FakeGateway();
    const out = await scopeDial(gw, parseScope('ag-sales'), GROUPS);
    expect(out.allowed.map((g) => g.id)).toEqual(['ag-sales']);
    expect(out.blocked.map((g) => g.id)).toEqual(['ag-support']);
    const live = liveDial(gw);
    expect(live.map((r) => [r.name, r.action, r.identities])).toEqual([
      [BLOCK_RULE, 'block', [{ type: 'agent', id: 'oc-support' }]],
    ]);
    // Never an allow rule: with its agent gone it would open Dial to everyone.
    expect(gw.calls.some((c) => c.includes(' allow '))).toBe(false);
    expect(gw.calls.at(-2)).toBe('publish');
    // The OneCLI default agent is not a NanoClaw group: never named.
    expect(gw.calls.some((c) => c.includes('oc-default'))).toBe(false);
  });

  it('`all` leaves no rule at all; `none` blocks every group; `none` before any group blocks every agent', async () => {
    const all = new FakeGateway();
    await scopeDial(all, parseScope('all'), GROUPS);
    expect(liveDial(all)).toEqual([]);
    expect(all.calls).toContain('publish');

    const none = new FakeGateway();
    const out = await scopeDial(none, parseScope('none'), GROUPS);
    expect(out.allowed).toEqual([]);
    expect(liveDial(none).map(ids)).toEqual([['oc-sales', 'oc-support']]);

    // Naming every group is `all`: no rule, and never an identity-less block.
    const every = new FakeGateway();
    await scopeDial(every, parseScope('ag-sales,ag-support'), GROUPS);
    expect(liveDial(every)).toEqual([]);
    const single = new FakeGateway([AGENTS[0], AGENTS[1]]);
    await scopeDial(single, parseScope('ag-sales'), [GROUPS[0]]);
    expect(liveDial(single)).toEqual([]);

    const fresh = new FakeGateway();
    await scopeDial(fresh, parseScope('none'), []);
    expect(liveDial(fresh).map(ids)).toEqual([[]]);
  });

  it('the first-agent onboarding path (`all` before any group exists) writes nothing that would block it', async () => {
    const gw = new FakeGateway();
    await scopeDial(gw, parseScope('all'), []);
    expect(liveDial(gw)).toEqual([]);
  });

  it('replaces its own earlier rule and the migrated legacy per-agent blocks', async () => {
    const gw = new FakeGateway(AGENTS, [
      rule({ id: 'old', logicalId: 'lo', identities: [{ type: 'agent', id: 'oc-sales' }] }),
      rule({
        id: 'migrated',
        logicalId: 'lm',
        name: 'Dial: blocked for Sales',
        identities: [{ type: 'agent', id: 'oc-sales' }],
        priority: 2,
      }),
    ]);
    await scopeDial(gw, parseScope('ag-sales'), GROUPS);
    expect(gw.calls.filter((c) => c.startsWith('delete')).sort()).toEqual(['delete migrated', 'delete old']);
    expect(liveDial(gw).map((r) => [r.name, ids(r)])).toEqual([[BLOCK_RULE, ['oc-support']]]);
  });

  it('splits more than 100 blocked agents over several rules', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ id: `ag-${i}`, name: `G${i}` }));
    const agents = many.map((g) => ({ id: `oc-${g.id}`, identifier: g.id, name: g.name }));
    const gw = new FakeGateway(agents);
    await scopeDial(gw, parseScope('ag-0'), many);
    const live = liveDial(gw);
    expect(live.map((r) => r.identities.length)).toEqual([100, 29]);
    expect(live.every((r) => r.name === BLOCK_RULE)).toBe(true);
  });

  it("leaves an operator's own rules alone, Dial-named or not", async () => {
    const ops = [
      rule({
        id: 'op-1',
        logicalId: 'o1',
        name: 'ops: no calls',
        targets: [{ kind: 'network', hostPattern: DIAL_HOST, pathPattern: '/v1/calls', method: null }],
      }),
      rule({ id: 'op-2', logicalId: 'o2', name: 'Dial: emergency deny', priority: 2 }),
      rule({ id: 'op-3', logicalId: 'o3', name: 'Dial: blocked for', priority: 3 }),
      rule({
        id: 'op-4',
        logicalId: 'o4',
        name: 'other ok',
        action: 'allow',
        priority: 4,
        targets: [{ kind: 'network', hostPattern: 'other.example', pathPattern: null, method: null }],
      }),
    ];
    const gw = new FakeGateway(AGENTS, ops);
    await scopeDial(gw, parseScope('ag-sales'), GROUPS);
    expect(gw.calls.some((c) => c.startsWith('delete'))).toBe(false);
    expect(gw.published.map((r) => r.id)).toEqual(['op-1', 'op-2', 'op-3', 'op-4', 'r1']);
  });

  it('stops before writing when an operator allow on the Dial host would win first-match', async () => {
    for (const host of [DIAL_HOST, '*.getdial.ai', 'api.*', '*']) {
      const gw = new FakeGateway(AGENTS, [
        rule({
          id: 'op',
          logicalId: 'o',
          name: 'dial ok',
          action: 'allow',
          targets: [{ kind: 'network', hostPattern: host }],
        }),
      ]);
      await expect(scopeDial(gw, parseScope('ag-sales'), GROUPS)).rejects.toThrow(
        /"dial ok" allows api\.getdial\.ai ahead of the Dial block/,
      );
      expect(gw.calls.some((c) => c.startsWith('create') || c.startsWith('delete') || c === 'publish')).toBe(false);
    }
    // A secret target reaches the Dial host too: every project secret, or the Dial key by id.
    for (const target of [
      { kind: 'secret', secretScope: 'project' },
      { kind: 'secret', secretId: 'sec-dial' },
    ]) {
      const gw = new FakeGateway(AGENTS, [
        rule({ id: 'op', logicalId: 'o', name: 'dial ok', action: 'allow', targets: [target] }),
      ]);
      gw.secrets = [{ id: 'sec-dial', name: 'Dial API', hostPattern: DIAL_HOST }];
      await expect(scopeDial(gw, parseScope('ag-sales'), GROUPS)).rejects.toThrow(/"dial ok" allows/);
    }
    // A disabled one, one on another host or secret, or a derived equipment row does not count.
    const fine = new FakeGateway(AGENTS, [
      rule({ id: 'a', logicalId: 'a', name: 'off', action: 'allow', enabled: false }),
      rule({
        id: 'c',
        logicalId: 'c',
        name: 'other key',
        action: 'allow',
        priority: 3,
        targets: [{ kind: 'secret', secretId: 'sec-other' }],
      }),
      rule({
        id: 'd',
        logicalId: 'd',
        name: 'equipment',
        action: 'allow',
        priority: 4,
        source: 'equipment',
        targets: [{ kind: 'secret', secretScope: 'project' }],
      }),
      rule({
        id: 'b',
        logicalId: 'b',
        name: 'elsewhere',
        action: 'allow',
        priority: 2,
        targets: [{ kind: 'network', hostPattern: 'getdial.ai' }],
      }),
    ]);
    await scopeDial(fine, parseScope('ag-sales'), GROUPS);
    expect(fine.calls).toContain('publish');
  });

  it('keeps agents blocked by another NanoClaw install on the same gateway', async () => {
    const gw = new FakeGateway(AGENTS, [
      rule({
        id: 'theirs',
        logicalId: 't',
        identities: [
          { type: 'agent', id: 'oc-other-install' },
          { type: 'agent', id: 'oc-sales' },
        ],
      }),
    ]);
    await scopeDial(gw, parseScope('ag-sales'), GROUPS);
    expect(liveDial(gw).map((r) => ids(r).sort())).toEqual([['oc-other-install', 'oc-support']]);
    // A run that died between its delete and its create left the draft empty; the published set still knows.
    const retry = new FakeGateway(AGENTS, [
      rule({ id: 'theirs', logicalId: 't', identities: [{ type: 'agent', id: 'oc-other-install' }] }),
    ]);
    retry.draft = [];
    await scopeDial(retry, parseScope('ag-sales'), GROUPS);
    expect(liveDial(retry).map((r) => ids(r).sort())).toEqual([['oc-other-install', 'oc-support']]);
    const all = new FakeGateway(AGENTS, [
      rule({ id: 'theirs', logicalId: 't', identities: [{ type: 'agent', id: 'oc-other-install' }] }),
    ]);
    await scopeDial(all, parseScope('all'), GROUPS);
    expect(liveDial(all).map(ids)).toEqual([['oc-other-install']]);
  });

  it('refuses to publish over an unpublished console edit, before and right before publishing', async () => {
    const op = rule({
      id: 'op',
      logicalId: 'o',
      name: 'ops',
      targets: [{ kind: 'network', hostPattern: 'x.example' }],
    });
    const gw = new FakeGateway(AGENTS, [op]);
    gw.draft[0] = { ...gw.draft[0], enabled: false };
    await expect(scopeDial(gw, parseScope('all'), GROUPS)).rejects.toThrow(/unpublished changes \(ops\)/);
    expect(gw.calls.some((c) => c.startsWith('create') || c.startsWith('delete') || c === 'publish')).toBe(false);

    // An edit that lands while the script runs is caught by the re-check.
    const late = new FakeGateway(AGENTS, [op]);
    const create = late.createRule.bind(late);
    late.createRule = async (body) => {
      const r = await create(body);
      late.draft.push(
        rule({
          id: 'sneaky',
          logicalId: 'ls',
          name: 'sneaky allow',
          action: 'allow',
          priority: 99,
          targets: [{ kind: 'network', hostPattern: 'y.example' }],
        }),
      );
      return r;
    };
    await expect(scopeDial(late, parseScope('none'), GROUPS)).rejects.toThrow(/unpublished changes \(sneaky allow\)/);
    expect(late.calls).not.toContain('publish');
  });

  it('fails before writing when a group has no OneCLI agent or an id is unknown', async () => {
    const gw = new FakeGateway([AGENTS[1]]);
    await expect(scopeDial(gw, parseScope('ag-sales'), GROUPS)).rejects.toThrow(/no OneCLI agent for Support/);
    const gw2 = new FakeGateway();
    await expect(scopeDial(gw2, parseScope('ag-typo'), GROUPS)).rejects.toThrow(/unknown agent group 'ag-typo'/);
    for (const g of [gw, gw2]) expect(g.calls.some((c) => c !== 'agents')).toBe(false);
  });

  it('fails when the published policy does not read back as written', async () => {
    const gw = new FakeGateway();
    gw.publish = async () => {
      gw.published = gw.draft.map((r) => ({ ...r, identities: [] }));
    };
    await expect(scopeDial(gw, parseScope('ag-sales'), GROUPS)).rejects.toThrow(/does not block exactly/);
    const off = new FakeGateway();
    off.publish = async () => {
      off.published = off.draft.map((r) => ({ ...r, enabled: false }));
    };
    await expect(scopeDial(off, parseScope('none'), GROUPS)).rejects.toThrow(/stale or disabled/);
    // A block that lost its identities would block everyone: reported, not accepted.
    const widened = new FakeGateway();
    widened.publish = async () => {
      widened.published = [...widened.draft, rule({ id: 'extra', logicalId: 'le', priority: 50 })];
    };
    await expect(scopeDial(widened, parseScope('ag-sales'), GROUPS)).rejects.toThrow(/different set of agents/);
  });

  it('parses the selection the way the prompt validates it', () => {
    expect(parseScope('ag-a, ag-b ,ag-a')).toEqual({ kind: 'ids', ids: ['ag-a', 'ag-b'] });
    expect(parseScope('all')).toEqual({ kind: 'all' });
    for (const bad of ['', 'all,ag-a', 'none,all', 'Sales', 'ag-a;rm']) {
      expect(() => parseScope(bad)).toThrow(/invalid agent selection/);
    }
  });
});

describe('dial-policy: removal', () => {
  it('deletes its rules and the migrated ones, publishes, and is a no-op when none exist', async () => {
    const gw = new FakeGateway(AGENTS, [
      rule({ id: 'b', logicalId: 'lb' }),
      rule({ id: 'm', logicalId: 'lm', name: 'Dial: blocked for Sales', priority: 2 }),
      rule({ id: 'op', logicalId: 'lo', name: 'ops', priority: 3 }),
    ]);
    expect(await removeDial(gw)).toBe(2);
    expect(gw.published.map((r) => r.id)).toEqual(['op']);
    expect(gw.calls.at(-1)).toBe('publish');

    const empty = new FakeGateway();
    expect(await removeDial(empty)).toBe(0);
    expect(empty.calls).not.toContain('publish');
  });

  it('re-checks for console edits right before publishing the removal', async () => {
    const gw = new FakeGateway(AGENTS, [rule({ id: 'b', logicalId: 'lb' })]);
    const del = gw.deleteRule.bind(gw);
    gw.deleteRule = async (id) => {
      await del(id);
      gw.draft.push(
        rule({
          id: 'late',
          logicalId: 'll',
          name: 'late edit',
          targets: [{ kind: 'network', hostPattern: 'z.example' }],
        }),
      );
    };
    await expect(removeDial(gw)).rejects.toThrow(/unpublished changes \(late edit\)/);
    expect(gw.calls).not.toContain('publish');
  });

  it('refuses while a Dial secret is still in the vault, also one written while it runs', async () => {
    const gw = new FakeGateway(AGENTS, [rule({ id: 'b', logicalId: 'lb' })]);
    gw.secrets = [{ id: 's', name: 'Dial API', hostPattern: DIAL_HOST }];
    await expect(removeDial(gw)).rejects.toThrow(/still holds a Dial secret \(Dial API\)/);
    expect(gw.calls.some((c) => c.startsWith('delete') || c === 'publish')).toBe(false);

    const race = new FakeGateway(AGENTS, [rule({ id: 'b', logicalId: 'lb' })]);
    const del = race.deleteRule.bind(race);
    race.deleteRule = async (id) => {
      await del(id);
      race.secrets = [{ id: 's', name: 'Dial API', hostPattern: DIAL_HOST }];
    };
    await expect(removeDial(race)).rejects.toThrow(/still holds a Dial secret/);
    expect(race.calls).not.toContain('publish');
  });
});

describe('dial-policy: unpublished-change detection', () => {
  const op = rule({ id: 'd1', logicalId: 'x', name: 'ops', targets: [{ kind: 'network', hostPattern: 'x.example' }] });
  const published = { ...op, id: 'p1' };
  it('ignores row ids, Dial rules and bridge-derived rows; flags edits, adds and deletes', () => {
    expect(unpublishedChanges([op], [published])).toEqual([]);
    expect(unpublishedChanges([op, rule({ id: 'z', logicalId: 'z', priority: 9 })], [published])).toEqual([]);
    expect(
      unpublishedChanges([op, { ...op, id: 'e', logicalId: 'e', name: 'equipment', source: 'equipment' }], [published]),
    ).toEqual([]);
    expect(unpublishedChanges([{ ...op, enabled: false }], [published])).toEqual(['ops']);
    expect(unpublishedChanges([op, { ...op, id: 'n', logicalId: 'n', name: 'new', priority: 2 }], [published])).toEqual(
      ['new'],
    );
    expect(unpublishedChanges([], [published])).toEqual(['ops']);
  });
  it('flags modifier, condition, order and default-rule changes', () => {
    expect(unpublishedChanges([{ ...op, requireApproval: true }], [published])).toEqual(['ops']);
    expect(unpublishedChanges([{ ...op, rateLimit: 5, rateLimitWindow: 'minute' }], [published])).toEqual(['ops']);
    expect(unpublishedChanges([{ ...op, conditions: [{ field: 'body', contains: 'x' }] }], [published])).toEqual([
      'ops',
    ]);
    const two = { ...op, id: 'd2', logicalId: 'y', name: 'two', priority: 2 };
    expect(unpublishedChanges([op, two], [published, { ...two, id: 'p2' }])).toEqual([]);
    expect(unpublishedChanges([{ ...op, priority: 3 }, two], [published, { ...two, id: 'p2' }])).toEqual([
      '(rule order)',
    ]);
    expect(unpublishedChanges([op], [published], { draft: 'block', published: 'allow' })).toEqual(['(default rule)']);
    // Moving a custom rule across a derived blocklist row is a reorder too.
    const deny = { ...op, id: 'b1', logicalId: 'bl', name: 'blocklist', source: 'blocklist', priority: 1 };
    const allow = { ...op, id: 'a1', logicalId: 'al', name: 'later allow', action: 'allow', priority: 2 };
    expect(unpublishedChanges([deny, allow], [deny, allow])).toEqual([]);
    expect(unpublishedChanges([{ ...allow, priority: 0 }, deny], [deny, allow])).toEqual(['(rule order)']);
  });
});

describe('dial-policy: the HTTP client', () => {
  it('sends the bearer key to the policy routes and surfaces the error envelope', async () => {
    const seen: Array<[string, RequestInit]> = [];
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      seen.push([url, init]);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/v1/policy/publish')) return new Response('{"generation":2,"ruleCount":3}');
      if (url.includes('/v1/policy/rules?status=')) return new Response('[]');
      if (url.includes('/v1/policy/default?status=')) return new Response('{"isDefault":true,"action":"allow"}');
      if (url.endsWith('/v1/secrets')) {
        return new Response('[{"id":"s","name":"Dial API","hostPattern":"api.getdial.ai","valuePreview":"x"}]');
      }
      if (url.endsWith('/v1/policy/rules')) {
        return new Response(
          JSON.stringify({ error: { message: 'Policy editing is not enabled for this deployment yet.', type: 'x' } }),
          { status: 403 },
        );
      }
      return new Response('[{"id":"oc-1","identifier":"ag-1","name":"One"}]');
    });
    const client = createPolicyClient('http://gw.test:10254/', 'oc_key', transport as unknown as typeof fetch);
    expect(await client.listAgents()).toEqual([{ id: 'oc-1', identifier: 'ag-1', name: 'One' }]);
    expect(await client.listRules('published')).toEqual([]);
    expect(await client.defaultAction('draft')).toBe('allow');
    expect(await client.listSecrets()).toEqual([{ id: 's', name: 'Dial API', hostPattern: 'api.getdial.ai' }]);
    await client.deleteRule('r/1');
    await client.publish();
    await expect(client.createRule({ name: 'x' })).rejects.toThrow(PolicyApiError);
    await expect(client.createRule({ name: 'x' })).rejects.toThrow(/403: Policy editing is not enabled/);
    expect(seen.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'GET http://gw.test:10254/v1/agents',
      'GET http://gw.test:10254/v1/policy/rules?status=published',
      'GET http://gw.test:10254/v1/policy/default?status=draft',
      'GET http://gw.test:10254/v1/secrets',
      'DELETE http://gw.test:10254/v1/policy/rules/r%2F1',
      'POST http://gw.test:10254/v1/policy/publish',
      'POST http://gw.test:10254/v1/policy/rules',
      'POST http://gw.test:10254/v1/policy/rules',
    ]);
    for (const [, init] of seen) expect((init.headers as Record<string, string>).Authorization).toBe('Bearer oc_key');
    expect((seen[6][1].headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('goes without a key when the CLI has none, and rejects a bad host', async () => {
    const transport = vi.fn(async () => new Response('[]'));
    await createPolicyClient('http://gw.test', '', transport as unknown as typeof fetch).listAgents();
    expect((transport.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({});
    expect(() => createPolicyClient('ftp://gw.test', '')).toThrow(/api-host/);
    expect(() => createPolicyClient('http://u:p@gw.test', '')).toThrow(/api-host/);
  });
});

// The whole script as the skill runs it: a stub onecli/ncl on PATH and a
// fake gateway over real HTTP.
describe('dial-policy: the command', () => {
  const SCRIPT = fileURLToPath(new URL('./dial-policy.ts', import.meta.url));
  let root: string;
  let server: http.Server;
  afterEach(() => {
    server?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  async function gateway(): Promise<{ url: string; log: string[]; rules: () => unknown[]; secrets: unknown[] }> {
    const log: string[] = [];
    const secrets: unknown[] = [];
    let draft: Array<Record<string, unknown>> = [];
    let published: Array<Record<string, unknown>> = [];
    let n = 0;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        log.push(`${req.method} ${req.url} ${req.headers.authorization ?? '-'}`);
        const json = (code: number, v: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(v === undefined ? undefined : JSON.stringify(v));
        };
        if (req.url === '/v1/agents') return json(200, AGENTS);
        if (req.url === '/v1/secrets') return json(200, secrets);
        if (req.url === '/v1/policy/rules?status=draft') return json(200, draft);
        if (req.url === '/v1/policy/rules?status=published') return json(200, published);
        if (req.url?.startsWith('/v1/policy/default')) return json(200, { isDefault: true, action: 'allow' });
        if (req.method === 'POST' && req.url === '/v1/policy/rules') {
          const b = JSON.parse(body) as Record<string, unknown>;
          const created = {
            id: `r${++n}`,
            logicalId: `l${n}`,
            source: 'custom',
            enabled: true,
            priority: n,
            identities: [],
            ...b,
          };
          draft.push(created);
          return json(201, created);
        }
        if (req.method === 'DELETE' && req.url?.startsWith('/v1/policy/rules/')) {
          draft = draft.filter((r) => r.id !== decodeURIComponent(req.url!.slice('/v1/policy/rules/'.length)));
          return json(204, undefined);
        }
        if (req.method === 'POST' && req.url === '/v1/policy/publish') {
          published = draft.map((r) => ({ ...r }));
          return json(200, { generation: 1, ruleCount: published.length });
        }
        json(404, { error: { message: 'no', type: 'invalid_request_error' } });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}`, log, rules: () => published, secrets };
  }

  function stubs(url: string, opts: { apiKey?: boolean } = {}): string {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dial-policy-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const write = (name: string, body: string) =>
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    write(
      'onecli',
      `case "$1 $2" in
  "config get") echo '{"key":"api-host","value":"${url}"}' ;;
  "auth api-key") ${opts.apiKey === false ? 'echo "not logged in" >&2; exit 1' : `echo '{"apiKey":"oc_stub"}'`} ;;
  *) exit 1 ;;
esac`,
    );
    write('ncl', `echo '${JSON.stringify({ ok: true, data: GROUPS })}'`);
    return bin;
  }

  // Async: the fake gateway lives on this event loop, so a blocking spawn
  // would never see a reply.
  function cli(bin: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        'pnpm',
        ['exec', 'tsx', SCRIPT, ...args],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          cwd: path.resolve(path.dirname(SCRIPT), '../../../..'),
        },
        (err, stdout, stderr) =>
          resolve({
            status: err ? ((err as { code?: number }).code ?? 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
    });
  }

  it('scopes, then removes, through the gateway the CLI is configured for', async () => {
    const gw = await gateway();
    const bin = stubs(gw.url);
    const r = await cli(bin, ['scope', '--agents', 'ag-sales']);
    expect(r.status).toBe(0);
    // stdout is the skill's capture: ids and the final word only; names go to stderr.
    expect(r.stdout).toBe('allowed:ag-sales\nblocked:ag-support\npublished\n');
    expect(r.stderr).toContain('allowed: Sales (ag-sales)');
    expect(r.stderr).toContain('blocked: Support (ag-support)');
    expect(gw.rules().map((x) => (x as { name: string }).name)).toEqual([BLOCK_RULE]);
    expect(gw.log.every((l) => l.endsWith(' Bearer oc_stub'))).toBe(true);

    gw.secrets.push({ id: 's', name: 'Dial API', hostPattern: DIAL_HOST });
    const held = await cli(bin, ['remove']);
    expect(held.status).toBe(1);
    expect(held.stderr).toContain('still holds a Dial secret');
    gw.secrets.length = 0;
    const rm = await cli(bin, ['remove']);
    expect(rm.status).toBe(0);
    expect(rm.stdout).toContain('removed 1 Dial policy rule(s)');
    expect(gw.rules()).toEqual([]);
  }, 60_000);

  it('runs keyless when the CLI holds no key, and fails loudly on a bad selection', async () => {
    const gw = await gateway();
    const bin = stubs(gw.url, { apiKey: false });
    expect((await cli(bin, ['scope', '--agents', 'none'])).status).toBe(0);
    expect(gw.log.every((l) => l.endsWith(' -'))).toBe(true);
    const bad = await cli(bin, ['scope', '--agents', 'ag-nope']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("unknown agent group 'ag-nope'");
  }, 60_000);
});
