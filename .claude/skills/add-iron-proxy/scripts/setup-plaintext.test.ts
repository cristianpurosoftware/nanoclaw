import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertNoPlaintextOverlap, configureCredential, statePaths, validatePlaintextModel } from './setup.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function projectWithPlaintextModel(origins: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-plaintext-'));
  roots.push(root);
  fs.mkdirSync(statePaths(root).shared, { recursive: true });
  fs.writeFileSync(statePaths(root).plaintextModels, JSON.stringify(origins));
  return root;
}

it.each(['host.docker.internal:8000', ' HOST.docker.internal:65535 '])('accepts the pinned local model %s', (raw) => {
  expect(validatePlaintextModel(raw)).toBe(raw.trim().toLowerCase());
});

it.each([
  'host.docker.internal',
  'host.docker.internal:0',
  'host.docker.internal:65536',
  'host.docker.internal:08000',
  'models.example.test:8000',
  'sub.host.docker.internal:8000',
  '172.17.0.1:8000',
])('refuses %s as a plaintext model endpoint', (raw) => {
  expect(() => validatePlaintextModel(raw)).toThrow('must be host.docker.internal:<port>');
});

it.each(['host.docker.internal', '*.docker.internal'])(
  'refuses to store a key for %s while that host is reachable over plain HTTP',
  async (modelHost) => {
    const root = projectWithPlaintextModel(['host.docker.internal:8000']);
    await expect(
      configureCredential({ secret: 'sk-test', authEnv: 'ANTHROPIC_API_KEY', modelHost }, root),
    ).rejects.toThrow('reachable over plain HTTP');
    expect(fs.existsSync(statePaths(root).secretFile)).toBe(false);
  },
);

it('also refuses while the running front still pins the host after the saved pin was cleared', () => {
  const root = projectWithPlaintextModel([]);
  fs.writeFileSync(
    statePaths(root).frontConfigFile,
    JSON.stringify({ plaintext_origins: ['host.docker.internal:8000'] }),
  );
  expect(() => assertNoPlaintextOverlap({ host: 'host.docker.internal' }, root)).toThrow('reachable over plain HTTP');
  expect(() => assertNoPlaintextOverlap({ cidr: '0.0.0.0/0' }, root)).toThrow('reachable over plain HTTP');
  expect(() => assertNoPlaintextOverlap({ host: 'api.anthropic.com' }, root)).not.toThrow();
});
