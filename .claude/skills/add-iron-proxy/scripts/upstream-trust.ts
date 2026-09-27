import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

/**
 * Names no public CA certifies, with their subdomains: IANA special-use names and the
 * TLDs ICANN will never delegate (home, corp, mail).
 */
export const PRIVATE_NAME = /(?:^|\.)(?:internal|local|localhost|home\.arpa|home|corp|mail)$/;

/** Outside Iron's read-only /etc/iron-proxy binds: Docker cannot nest a mount under one. */
const CONTAINER_TRUST_DIR = '/etc/iron-upstream-trust';
const CA_FILE = 'local-ca.pem';

const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface Tlv {
  tag: number;
  body: Buffer;
}

function readTlv(buf: Buffer, offset: number): Tlv & { next: number } {
  if (offset + 2 > buf.length) throw new Error('truncated DER');
  const tag = buf[offset];
  let length = buf[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes < 1 || bytes > 4 || start + bytes > buf.length) throw new Error('bad DER length');
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + buf[start + i];
    // DER uses the shortest length form; Go rejects anything else.
    if (length < 0x80 || buf[start] === 0) throw new Error('non-DER length');
    start += bytes;
  }
  if (start + length > buf.length) throw new Error('truncated DER');
  return { tag, body: buf.subarray(start, start + length), next: start + length };
}

function children(body: Buffer): Tlv[] {
  const out: Tlv[] = [];
  for (let offset = 0; offset < body.length; ) {
    const tlv = readTlv(body, offset);
    out.push(tlv);
    offset = tlv.next;
  }
  return out;
}

const NAME_CONSTRAINTS_OID = Buffer.from([0x55, 0x1d, 0x1e]);
const SUBJECT_ALT_NAME_OID = Buffer.from([0x55, 0x1d, 0x11]);

/** dNSName entries (implicit tag [2]) of a GeneralSubtrees field. */
const dnsSubtrees = (subtrees: Tlv | undefined): string[] =>
  subtrees
    ? children(subtrees.body)
        .map((subtree) => children(subtree.body)[0])
        .filter((name) => name.tag === 0x82)
        // latin1 keeps high bytes, so a non-ASCII name Go would reject fails DNS_NAME.
        .map((name) => name.body.toString('latin1').toLowerCase())
    : [];

/** Private IPv4 and IPv6 ranges as [network, prefix length]. */
const PRIVATE_RANGES: [number[], number][] = [
  [[10, 0, 0, 0], 8],
  [[172, 16, 0, 0], 12],
  [[192, 168, 0, 0], 16],
  [[0xfc, ...Array(15).fill(0)], 7],
];

const prefixLength = (mask: Buffer): number | undefined => {
  const bits = [...mask].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  return /^1*0*$/.test(bits) ? (bits.indexOf('0') === -1 ? bits.length : bits.indexOf('0')) : undefined;
};

/** An iPAddress subtree (implicit tag [7]) is an IPv4 or IPv6 address plus a contiguous mask. */
const wellFormedIp = (body: Buffer) =>
  (body.length === 8 || body.length === 32) && prefixLength(body.subarray(body.length / 2)) !== undefined;

/** A permitted iPAddress subtree lies inside a private range. */
function privateIpSubtree(body: Buffer): boolean {
  if (!wellFormedIp(body)) return false;
  const size = body.length / 2;
  const address = body.subarray(0, size);
  const prefix = prefixLength(body.subarray(size))!;
  return PRIVATE_RANGES.some(([network, bits]) => {
    if (network.length !== size || prefix < bits) return false;
    for (let bit = 0; bit < bits; bit++) {
      const mask = 0x80 >> (bit % 8);
      if ((address[bit >> 3] & mask) !== (network[bit >> 3] & mask)) return false;
    }
    return true;
  });
}

function nameConstraints(der: Buffer): { permittedDns: string[]; excludedDns: string[] } {
  const [tbs] = children(readTlv(der, 0).body);
  // Go ignores extensions on anything but v3, so constraints on a v1/v2 root bind nothing.
  const [version] = children(tbs.body);
  if (version.tag !== 0xa0 || !children(version.body)[0].body.equals(Buffer.from([2])))
    throw new Error('it is not an X.509 v3 certificate, so its constraints would be ignored');
  const extensions = children(tbs.body).find((field) => field.tag === 0xa3);
  const all = extensions ? children(children(extensions.body)[0].body).map((ext) => children(ext.body)) : [];
  const find = (oid: Buffer) => all.find(([id]) => id.tag === 0x06 && id.body.equals(oid));
  // Name constraints never apply to the trust anchor itself, so a CA with its own
  // SAN could be served as the leaf for any name it lists, public ones included.
  if (find(SUBJECT_ALT_NAME_OID)) throw new Error('it carries its own subjectAltName and could be served as a leaf');
  const extension = find(NAME_CONSTRAINTS_OID);
  if (!extension) throw new Error('it has no name constraints');
  const critical = extension.length === 3 && extension[1].tag === 0x01 && extension[1].body.equals(Buffer.from([0xff]));
  if (!critical) throw new Error('its name constraints are not marked critical');
  const fields = children(extension[extension.length - 1].body).flatMap((value) => children(value.body));
  // Go refuses to verify through constraints it does not handle, so such a CA would never work.
  for (const subtree of fields.flatMap((field) => children(field.body))) {
    const parts = children(subtree.body);
    if (parts.length !== 1 || (parts[0].tag !== 0x82 && parts[0].tag !== 0x87))
      throw new Error('its name constraints use subtree types other than DNS names and IP ranges');
    if (parts[0].tag === 0x87 && !wellFormedIp(parts[0].body))
      throw new Error('its name constraints hold a malformed IP range');
  }
  const permitted = fields.find((field) => field.tag === 0xa0);
  const permittedDns = dnsSubtrees(permitted);
  // RFC 5280: a CA with no subtree of a name type in its permitted list may sign any
  // name of that type. Iron cannot reach IPs over https, but the CA must not vouch for them.
  if (!permittedDns.length) throw new Error('its name constraints permit no DNS names, so any DNS name is allowed');
  const permittedIps = permitted
    ? children(permitted.body)
        .map((subtree) => children(subtree.body)[0])
        .filter((name) => name.tag === 0x87)
    : [];
  if (!permittedIps.length)
    throw new Error('its name constraints permit no IP range, so any IP address is allowed (add your LAN range)');
  if (!permittedIps.every((ip) => privateIpSubtree(ip.body)))
    throw new Error('its name constraints permit an IP range outside 10/8, 172.16/12, 192.168/16 and fc00::/7');
  return { permittedDns, excludedDns: dnsSubtrees(fields.find((field) => field.tag === 0xa1)) };
}

export interface UpstreamCa {
  subject: string;
  /** Re-encoded from the validated DER, so Go's PEM decoder cannot read something else. */
  pem: string;
  permittedDns: string[];
  excludedDns: string[];
}

/**
 * Accept only a CA that cannot vouch for a public host. Go enforces name constraints,
 * so a CA limited to private zones cannot impersonate a model API and receive its key.
 */
export function parseUpstreamCa(pem: string, now = Date.now()): UpstreamCa {
  const refuse = (reason: string) =>
    new Error(
      `Iron can only trust a local CA that is limited to private names; this one is refused because ${reason}.`,
    );
  if (/PRIVATE KEY-----/.test(pem)) throw refuse('the file contains a private key (give Iron only the CA certificate)');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length !== 1 || pem.match(/-----BEGIN /g)?.length !== 1)
    throw refuse('the file must hold exactly one PEM certificate');
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(blocks[0]);
  } catch {
    throw refuse('it is not a readable certificate');
  }
  if (!cert.ca) throw refuse('it is not a CA certificate');
  if (Date.parse(cert.validTo) <= now) throw refuse('it has expired');
  if (Date.parse(cert.validFrom) > now) throw refuse('it is not valid yet');
  let constraints: ReturnType<typeof nameConstraints>;
  try {
    constraints = nameConstraints(cert.raw);
  } catch (error) {
    throw refuse((error as Error).message);
  }
  for (const name of constraints.excludedDns) {
    const zone = name.replace(/^\./, '');
    if (!DNS_NAME.test(zone) && !/^[a-z0-9-]+$/.test(zone)) throw refuse(`it excludes the malformed name "${name}"`);
  }
  for (const name of constraints.permittedDns) {
    const zone = name.replace(/^\./, '');
    if (!DNS_NAME.test(zone) && !/^[a-z0-9-]+$/.test(zone)) throw refuse(`it permits the malformed name "${name}"`);
    if (!PRIVATE_NAME.test(zone)) throw refuse(`it permits "${name}", which is not a private name`);
  }
  const base64 = cert.raw.toString('base64').replace(/.{1,64}/g, '$&\n');
  return {
    subject: cert.subject.replace(/\n/g, ', '),
    pem: `-----BEGIN CERTIFICATE-----\n${base64}-----END CERTIFICATE-----\n`,
    ...constraints,
  };
}

/** Go's matchDomainConstraint: ".zone" covers subdomains only; "zone" also covers itself. */
const matchesDomain = (name: string, constraint: string) =>
  constraint.startsWith('.') ? name.endsWith(constraint) : name === constraint || name.endsWith('.' + constraint);

export function coveredByUpstreamCa(host: string, ca: UpstreamCa): boolean {
  const name = host.toLowerCase();
  return (
    ca.permittedDns.some((constraint) => matchesDomain(name, constraint)) &&
    !ca.excludedDns.some((constraint) => matchesDomain(name, constraint))
  );
}

const trustDir = (shared: string) => path.join(shared, 'upstream-trust');

/** The installed CA, revalidated on every read so a hand-edited file cannot widen trust. */
export function readUpstreamCa(shared: string): UpstreamCa | undefined {
  const file = path.join(trustDir(shared), CA_FILE);
  if (!fs.existsSync(file)) return undefined;
  return parseUpstreamCa(fs.readFileSync(file, 'utf8'));
}

export function installUpstreamCa(pem: string, shared: string): UpstreamCa {
  const ca = parseUpstreamCa(pem);
  const dir = trustDir(shared);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, CA_FILE), ca.pem, { mode: 0o644 });
  fs.chmodSync(path.join(dir, CA_FILE), 0o644);
  return ca;
}

export function clearUpstreamCa(shared: string): void {
  fs.rmSync(trustDir(shared), { recursive: true, force: true });
}

/**
 * SSL_CERT_DIR, never SSL_CERT_FILE: Go still loads the image's public bundle file,
 * so the local CA is added to public roots. Only the validated file is mounted,
 * because Go trusts every certificate file in that directory.
 */
export function upstreamTrustArgs(shared: string): string[] {
  if (!readUpstreamCa(shared)) return [];
  return [
    '-v',
    `${path.join(trustDir(shared), CA_FILE)}:${CONTAINER_TRUST_DIR}/${CA_FILE}:ro`,
    '-e',
    `SSL_CERT_DIR=${CONTAINER_TRUST_DIR}`,
  ];
}

/** `name:address` pairs for Iron's /etc/hosts, for private names the host's DNS does not serve. */
export function upstreamHostArgs(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const split = entry.indexOf(':');
      const name = entry.slice(0, split).toLowerCase();
      const address = entry.slice(split + 1);
      // Docker rejects IPv6 zone ids, and it would do so after the running proxy is removed.
      if (
        split < 1 ||
        !DNS_NAME.test(name) ||
        !((isIP(address) && !address.includes('%')) || address === 'host-gateway')
      )
        throw new Error(`NANOCLAW_IRON_EXTRA_HOSTS entry must be <dns-name>:<ip>; got "${entry}"`);
      return ['--add-host', `${name}:${address}`];
    });
}
