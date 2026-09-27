import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearUpstreamCa,
  coveredByUpstreamCa,
  installUpstreamCa,
  parseUpstreamCa,
  readUpstreamCa,
  upstreamHostArgs,
  upstreamTrustArgs,
} from './upstream-trust.js';

const pem = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, 'testdata', 'upstream-ca', `${name}.pem`), 'utf8');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const shared = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-upstream-'));
  roots.push(root);
  return root;
};

describe('parseUpstreamCa', () => {
  it('accepts a CA whose critical name constraints permit only private names', () => {
    expect(parseUpstreamCa(pem('constrained'))).toEqual({
      subject: 'CN=NanoClaw test constrained',
      pem: pem('constrained'),
      permittedDns: ['models.home.arpa', '.home.arpa'],
      excludedDns: [],
    });
  });
  it.each([
    ['unconstrained', /has no name constraints/],
    ['not-critical', /not marked critical/],
    ['public-zone', /permits "example.com", which is not a private name/],
    ['ip-only', /permit no DNS names/],
    ['excluded-only', /permit no DNS names/],
    ['leaf', /not a CA certificate/],
    ['self-san', /carries its own subjectAltName/],
    ['dns-only', /permit no IP range/],
    ['public-ip', /IP range outside/],
    ['non-contiguous-mask', /malformed IP range/],
    ['bad-excluded-ip', /malformed IP range/],
    ['other-type', /subtree types other than DNS names and IP ranges/],
  ])('refuses the %s certificate', (name, reason) => {
    expect(() => parseUpstreamCa(pem(name))).toThrow(reason);
  });
  it('refuses an expired CA', () => {
    expect(() => parseUpstreamCa(pem('constrained'), Date.parse('2200-01-01'))).toThrow(/expired/);
  });
  it('refuses a certificate nested inside another PEM block', () => {
    const nested = pem('constrained').replace('-----END CERTIFICATE-----', pem('unconstrained').trim());
    expect(() => parseUpstreamCa(nested)).toThrow(/exactly one PEM certificate/);
  });
  it('stores the validated DER, not the operator file', () => {
    const dir = shared();
    installUpstreamCa('# my LAN CA\n' + pem('constrained'), dir);
    expect(fs.readFileSync(path.join(dir, 'upstream-trust', 'local-ca.pem'), 'utf8')).toBe(pem('constrained'));
  });
  it('refuses a CA that is not valid yet', () => {
    expect(() => parseUpstreamCa(pem('constrained'), Date.parse('2000-01-01'))).toThrow(/not valid yet/);
  });
  it('accepts a private IPv6 range', () => {
    expect(parseUpstreamCa(pem('v6-ula')).permittedDns).toEqual(['.home.arpa']);
  });
  it('refuses a DNS constraint with non-ASCII bytes, which Go rejects', () => {
    const der = Buffer.from(pem('constrained').replace(/-----[^-]+-----|\s/g, ''), 'base64');
    const at = der.indexOf(Buffer.from('models.home.arpa'));
    expect(at).toBeGreaterThan(0);
    der[at] = 0xed;
    const tampered = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`;
    expect(() => parseUpstreamCa(tampered)).toThrow(/malformed name/);
  });
  it('refuses a critical flag Go would not read as DER TRUE', () => {
    const der = Buffer.from(pem('constrained').replace(/-----[^-]+-----|\s/g, ''), 'base64');
    const at = der.indexOf(Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e, 0x01, 0x01, 0xff]));
    expect(at).toBeGreaterThan(0);
    der[at + 7] = 0x01;
    const tampered = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`;
    expect(() => parseUpstreamCa(tampered)).toThrow(/not marked critical/);
  });
  it('refuses a v2 certificate, whose extensions Go ignores', () => {
    const der = Buffer.from(pem('constrained').replace(/-----[^-]+-----|\s/g, ''), 'base64');
    const at = der.indexOf(Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]));
    expect(at).toBeGreaterThan(0);
    der[at + 4] = 0x01;
    const v2 = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`;
    expect(() => parseUpstreamCa(v2)).toThrow(/not an X.509 v3 certificate/);
  });
  it('refuses a file carrying a private key or more than one certificate', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n';
    expect(() => parseUpstreamCa(pem('constrained') + key)).toThrow(/private key/);
    expect(() => parseUpstreamCa(pem('constrained') + pem('leaf'))).toThrow(/exactly one/);
    expect(() => parseUpstreamCa('not a certificate')).toThrow(/exactly one/);
  });
});

describe('coveredByUpstreamCa', () => {
  const ca = parseUpstreamCa(pem('constrained'));
  it.each([
    ['models.home.arpa', true],
    ['MODELS.HOME.ARPA', true],
    ['gpu.lab.home.arpa', true],
    ['home.arpa', false],
    ['models.corp', false],
    ['evilhome.arpa', false],
  ])('%s -> %s', (host, covered) => {
    expect(coveredByUpstreamCa(host, ca)).toBe(covered);
  });
  it('honours excluded subtrees', () => {
    const excluded = parseUpstreamCa(pem('with-excluded'));
    expect(excluded.excludedDns).toEqual(['models.home.arpa']);
    expect(coveredByUpstreamCa('models.home.arpa', excluded)).toBe(false);
    expect(coveredByUpstreamCa('gpu.home.arpa', excluded)).toBe(true);
  });
  it('treats a constraint without a leading dot as the zone and its subdomains', () => {
    const ca = { subject: '', pem: '', permittedDns: ['corp'], excludedDns: [] };
    expect(coveredByUpstreamCa('corp', ca)).toBe(true);
    expect(coveredByUpstreamCa('a.b.corp', ca)).toBe(true);
  });
});

describe('installed trust', () => {
  it('mounts nothing until a CA is installed, then adds it through SSL_CERT_DIR', () => {
    const dir = shared();
    expect(upstreamTrustArgs(dir)).toEqual([]);
    installUpstreamCa(pem('constrained'), dir);
    expect(upstreamTrustArgs(dir)).toEqual([
      '-v',
      `${path.join(dir, 'upstream-trust', 'local-ca.pem')}:/etc/iron-upstream-trust/local-ca.pem:ro`,
      '-e',
      'SSL_CERT_DIR=/etc/iron-upstream-trust',
    ]);
    expect(fs.statSync(path.join(dir, 'upstream-trust', 'local-ca.pem')).mode & 0o777).toBe(0o644);
    clearUpstreamCa(dir);
    expect(upstreamTrustArgs(dir)).toEqual([]);
  });
  it('writes nothing for a refused CA', () => {
    const dir = shared();
    expect(() => installUpstreamCa(pem('unconstrained'), dir)).toThrow();
    expect(fs.existsSync(path.join(dir, 'upstream-trust'))).toBe(false);
  });
  it('revalidates the stored file, so a swapped-in unconstrained CA is never mounted', () => {
    const dir = shared();
    installUpstreamCa(pem('constrained'), dir);
    fs.writeFileSync(path.join(dir, 'upstream-trust', 'local-ca.pem'), pem('unconstrained'));
    expect(() => readUpstreamCa(dir)).toThrow(/no name constraints/);
    expect(() => upstreamTrustArgs(dir)).toThrow(/no name constraints/);
  });
});

describe('upstreamHostArgs', () => {
  it('maps name:address pairs to --add-host', () => {
    expect(upstreamHostArgs(' Models.Home.Arpa:192.168.8.20, gpu.home.arpa:fd00::2,x.home.arpa:host-gateway')).toEqual([
      '--add-host',
      'models.home.arpa:192.168.8.20',
      '--add-host',
      'gpu.home.arpa:fd00::2',
      '--add-host',
      'x.home.arpa:host-gateway',
    ]);
    expect(upstreamHostArgs(undefined)).toEqual([]);
  });
  it.each([
    'models.home.arpa',
    ':192.168.8.20',
    'models.home.arpa:not-an-ip',
    '-bad.home.arpa:10.0.0.1',
    'x --privileged:1.2.3.4',
    'gpu.home.arpa:fe80::1%eth0',
  ])('refuses %s', (entry) => {
    expect(() => upstreamHostArgs(entry)).toThrow(/<dns-name>:<ip>/);
  });
});
