/**
 * Proves scripts/delete-cli-agent.ts stops the agent's containers before its
 * group folder is deleted, in one pass, and finds a leftover by folder on a
 * re-run. Runs the real entry point against a temp cwd and a fake CONTAINER_RUNTIME.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, 'delete-cli-agent.ts');
const MIGRATE = path.resolve(import.meta.dirname, 'migrate.ts');
const TSX_LOADER = path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs');
const FOLDER = 'ping_test';
const AGENT_GROUP_ID = 'ag-ping-test';
/** Pinned: the cwd-derived slug depends on tmpdir symlink resolution (macOS /var → /private/var). */
const INSTALL_ID = 'dcatest';

describe('scripts/delete-cli-agent.ts', () => {
  let cwd: string;
  let runtime: string;
  let log: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-dca-'));
    fs.mkdirSync(path.join(cwd, 'groups', FOLDER), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'data'));
    const migrated = spawnSync(process.execPath, ['--import', TSX_LOADER, MIGRATE], { cwd, encoding: 'utf8' });
    expect(migrated.status, migrated.stderr).toBe(0);
    const db = new Database(path.join(cwd, 'data', 'v2.db'));
    db.prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      AGENT_GROUP_ID,
      'Terminal Agent',
      FOLDER,
      'claude',
      new Date().toISOString(),
    );
    db.close();

    // Fake runtime over a `containers` file: `ps` prints it, `stop`/`rm` drop ids.
    // `fail` fails every stop/rm; `spawn-on-ps-<n>` is appended before the n-th `ps`.
    // Each call is logged with whether the folder still existed.
    log = path.join(cwd, 'runtime-calls.log');
    runtime = path.join(cwd, 'fake-docker');
    fs.writeFileSync(path.join(cwd, 'containers'), 'abc123\n');
    fs.writeFileSync(
      runtime,
      [
        '#!/bin/sh',
        `state="${cwd}"`,
        `if [ -d "${path.join(cwd, 'groups', FOLDER)}" ]; then folder=present; else folder=gone; fi`,
        `printf '%s folder=%s\\n' "$*" "$folder" >> "${log}"`,
        'n=$(( $(cat "$state/count-$1" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state/count-$1"',
        'case "$1" in',
        '  ps)',
        '    if [ -f "$state/spawn-on-ps-$n" ]; then cat "$state/spawn-on-ps-$n" >> "$state/containers"; fi',
        '    cat "$state/containers" ;;',
        '  stop|rm)',
        '    if [ -f "$state/fail" ]; then echo "permission denied" >&2; exit 1; fi',
        '    for id in "$@"; do grep -vxF -- "$id" "$state/containers" > "$state/containers.next"; mv "$state/containers.next" "$state/containers"; done ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    fs.chmodSync(runtime, 0o755);
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function run(env: Record<string, string> = {}) {
    return spawnSync(process.execPath, ['--import', TSX_LOADER, SCRIPT, '--folder', FOLDER], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CONTAINER_RUNTIME: runtime, NANOCLAW_INSTALL_ID: INSTALL_ID, ...env },
    });
  }

  const filters = `--filter label=nanoclaw-install=${INSTALL_ID} --filter label=nanoclaw-group-folder=${FOLDER}`;

  function groupRows() {
    const db = new Database(path.join(cwd, 'data', 'v2.db'), { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS count FROM agent_groups WHERE folder = ?').get(FOLDER) as {
      count: number;
    };
    db.close();
    return row.count;
  }

  it('stops and removes the container in one pass while its folder exists, then deletes the folder', () => {
    // A container that shows up after the one listing is not chased: no second pass, no wait.
    fs.writeFileSync(path.join(cwd, 'spawn-on-ps-2'), 'late456\n');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Stopped 1 container(s) for ping_test: abc123');
    expect(result.stdout).toContain(`Deleted agent group ${AGENT_GROUP_ID} (${FOLDER}).`);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      `ps -aq ${filters} folder=present`,
      'stop -t 10 abc123 folder=present',
      'rm --force abc123 folder=present',
    ]);
    expect(fs.existsSync(path.join(cwd, 'groups', FOLDER))).toBe(false);
    expect(groupRows()).toBe(0);
  });

  it('finds a leftover by folder on a re-run after the rows are gone', () => {
    const first = run({ CONTAINER_RUNTIME: path.join(cwd, 'missing-runtime') });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain('Could not clean up container(s) for ping_test');
    expect(groupRows()).toBe(0);

    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('Stopped 1 container(s) for ping_test: abc123');
    expect(second.stdout).toContain('No agent group with folder "ping_test"');
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')[0]).toBe(`ps -aq ${filters} folder=gone`);
    expect(fs.readFileSync(path.join(cwd, 'containers'), 'utf8')).toBe('');
  });

  it('names the survivors when stop and rm fail and still deletes the group', () => {
    fs.writeFileSync(path.join(cwd, 'fail'), '');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('Stopped');
    expect(result.stderr).toContain('permission denied');
    expect(result.stderr).toContain('still listed: abc123');
    expect(result.stdout).toContain(`Deleted agent group ${AGENT_GROUP_ID} (${FOLDER}).`);
  });

  it('still deletes the group when the runtime cannot be reached', () => {
    fs.writeFileSync(runtime, '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Could not clean up container(s) for ping_test');
    expect(fs.existsSync(path.join(cwd, 'groups', FOLDER))).toBe(false);
  });
});
