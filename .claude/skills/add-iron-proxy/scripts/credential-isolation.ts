import fs from 'node:fs';
import { getInstallSlug } from '../../../../src/install-slug.js';
import { controlPaths, controlRequest } from './control.js';

/** Keep repeated native Iron replacements under net/http's canonical map key. */
export function ironHeaderName(header: string): string {
  return header.toLowerCase().replace(/(^|-)[a-z]/g, (part) => part.toUpperCase());
}

export interface CredentialScope {
  host: string;
  headers: string[];
  proxyValue: string;
  ownedForeignIds: string[];
}

const SECRET_RESOURCES = {
  static_secret_id: 'static_secrets',
  gcp_auth_secret_id: 'gcp_auth_secrets',
  aws_auth_secret_id: 'aws_auth_secrets',
  oauth_token_secret_id: 'oauth_token_secrets',
  pg_dsn_secret_id: 'pg_dsn_secrets',
  hmac_secret_id: 'hmac_secrets',
};

/** Whether an Iron rule may apply to `target`; anything it cannot parse counts as a match. */
export function ruleCoversHost(rule: any, target: string): boolean {
  if (rule.cidr || typeof rule.host !== 'string') return true;
  const host = rule.host.toLowerCase();
  if ((host.includes('*') && (!host.startsWith('*.') || host.slice(2).includes('*'))) || /[?\[\\]/.test(host))
    return true;
  return (
    host === '*' ||
    host === '**' ||
    host === target ||
    (host.startsWith('*.') && (target === host.slice(2) || target.endsWith(host.slice(1))))
  );
}

/** Every secret granted to this install's principal or its roles. */
async function* grantedSecrets(
  root: string,
  request: (resource: string) => Promise<any>,
): AsyncGenerator<{ resource: string; secret: any }> {
  const { principalId } = JSON.parse(fs.readFileSync(controlPaths(root).registration, 'utf8'));
  const roles = await request(`principals/${principalId}/roles`);
  if (!Array.isArray(roles) || roles.some((role) => typeof role.id !== 'string'))
    throw new Error('Iron did not return a valid role list');
  for (const grantee of [`principals/${principalId}`, ...roles.map((role) => `roles/${encodeURIComponent(role.id)}`)]) {
    for (let page = 1; ; page++) {
      const grants = await request(`${grantee}/grants?limit=200&page=${page}`);
      if (!Array.isArray(grants)) throw new Error('Iron did not return a valid credential grant list');
      for (const grant of grants) {
        for (const [field, resource] of Object.entries(SECRET_RESOURCES)) {
          if (!grant[field]) continue;
          yield { resource, secret: await request(`${resource}/${encodeURIComponent(grant[field])}`) };
        }
      }
      if (grants.length < 200) break;
    }
  }
}

/** Plain HTTP carries whatever Iron injects, so no granted credential may apply to the host at all. */
export async function assertNoCredentialCovers(
  root: string,
  host: string,
  request = (resource: string) => controlRequest(root, resource),
): Promise<void> {
  for await (const { resource, secret } of grantedSecrets(root, request)) {
    // PostgreSQL DSNs reach Iron's database listener, never an HTTP request.
    if (resource === 'pg_dsn_secrets') continue;
    if (!secret.rules?.length || secret.rules.some((rule: any) => ruleCoversHost(rule, host)))
      throw new Error(
        `Iron credential ${secret.id} applies to ${host}, and Iron would send it over plain HTTP. Remove it or its grant in Iron Control, or use an https endpoint, before retrying.`,
      );
  }
}

/** Reject legacy or manual grants that could overwrite or reject this runtime's request. */
export async function assertCredentialIsolation(
  root: string,
  scope: CredentialScope,
  request = (resource: string) => controlRequest(root, resource),
): Promise<void> {
  const namespace = getInstallSlug(root);
  const matchesHost = (rule: any) => ruleCoversHost(rule, scope.host);
  const matchesHeader = (header: string) => scope.headers.some((h) => h.toLowerCase() === header.toLowerCase());
  for await (const { resource, secret } of grantedSecrets(root, request)) {
    if (secret.namespace === namespace && scope.ownedForeignIds.includes(secret.foreign_id)) continue;
    if (secret.rules?.length && !secret.rules.some(matchesHost)) continue;
    const replace = secret.replace_config;
    const headers = replace?.match_headers;
    const matchingReplacement = !headers?.length || headers.some((h: string) => h.startsWith('/') || matchesHeader(h));
    // Stock Iron rekeys literal headers even on a no-match replacement.
    const unsafeCasing = headers?.some(
      (h: string) => h.startsWith('/') || (matchesHeader(h) && h !== ironHeaderName(h)),
    );
    if (
      unsafeCasing ||
      resource !== 'static_secrets' ||
      secret.inject_config?.require ||
      replace?.require ||
      (secret.inject_config?.header && matchesHeader(secret.inject_config.header)) ||
      (matchingReplacement &&
        replace?.proxy_value &&
        (scope.proxyValue.includes(replace.proxy_value) || replace.proxy_value.includes(scope.proxyValue)))
    ) {
      throw new Error(
        `Iron credential ${secret.id} conflicts on ${scope.host}. Reconnect its provider with this skill version, or remove the conflicting grant in Iron Control before retrying. No credential has been replaced.`,
      );
    }
  }
}
