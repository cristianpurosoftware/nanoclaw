import { describe, expect, it } from 'vitest';

import { stopGroupContainers } from './group-containers.js';
import { CUTOVER_STOP_GRACE_SECONDS, type CommandRunner } from './service.js';

function fakeRunner(
  responses:
    | Record<string, { ok: boolean; stdout?: string }>
    | ((key: string) => { ok: boolean; stdout?: string } | undefined),
) {
  const calls: string[] = [];
  const lookup = typeof responses === 'function' ? responses : (key: string) => responses[key];
  const runner: CommandRunner = {
    run(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = lookup(key);
      if (response && !response.ok) throw new Error(response.stdout ?? 'failed');
      return response?.stdout ?? '';
    },
    tryRun(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      return { ok: true, stdout: '', ...lookup(key) };
    },
  };
  return { runner, calls };
}

const filters = '--filter label=nanoclaw-install=slug1 --filter label=nanoclaw-group-folder=ping_test';
const ps = `docker ps -aq ${filters}`;
const stop = (runner: CommandRunner) =>
  stopGroupContainers({ runtime: 'docker', installSlug: 'slug1', folder: 'ping_test', runner });

describe('stopGroupContainers', () => {
  it('stops and removes every container carrying the install and folder labels, in one listing', () => {
    const { runner, calls } = fakeRunner({ [ps]: { ok: true, stdout: 'aaa111\nbbb222\n' } });
    expect(stop(runner)).toEqual({ listed: ['aaa111', 'bbb222'], failures: [] });
    expect(calls).toEqual([
      ps,
      `docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} aaa111 bbb222`,
      'docker rm --force aaa111 bbb222',
    ]);
  });

  it('does nothing when the folder has no container', () => {
    const { runner, calls } = fakeRunner({ [ps]: { ok: true, stdout: '' } });
    expect(stop(runner)).toEqual({ listed: [], failures: [] });
    expect(calls).toEqual([ps]);
  });

  it('tolerates a container that vanished between list and stop (`--rm` sessions auto-remove)', () => {
    let listings = 0;
    const { runner, calls } = fakeRunner((key) => {
      if (key === ps) return { ok: true, stdout: listings++ === 0 ? 'aaa111' : '' };
      if (key.startsWith('docker stop') || key.startsWith('docker rm'))
        return { ok: false, stdout: 'Error response from daemon: No such container: aaa111' };
      return undefined;
    });
    expect(stop(runner)).toEqual({ listed: ['aaa111'], failures: [] });
    expect(calls).toEqual([ps, `docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} aaa111`, 'docker rm --force aaa111', ps]);
  });

  it('counts a successful forced rm as done even when the stop failed', () => {
    const { runner, calls } = fakeRunner((key) => {
      if (key === ps) return { ok: true, stdout: 'aaa111' };
      if (key.startsWith('docker stop')) return { ok: false, stdout: 'timeout' };
      return undefined;
    });
    expect(stop(runner)).toEqual({ listed: ['aaa111'], failures: [] });
    expect(calls).toEqual([ps, `docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} aaa111`, 'docker rm --force aaa111']);
  });

  it('reports the survivor and the errors when the runtime still lists the container', () => {
    const { runner } = fakeRunner((key) => {
      if (key === ps) return { ok: true, stdout: 'aaa111' };
      if (key.startsWith('docker rm')) return { ok: false, stdout: 'permission denied' };
      return undefined;
    });
    expect(stop(runner).failures).toEqual(['docker rm failed: permission denied', 'still listed: aaa111']);
  });

  it('reports a runtime that cannot be asked, and stops nothing', () => {
    const { runner, calls } = fakeRunner({ [ps]: { ok: false, stdout: 'Cannot connect to the Docker daemon' } });
    expect(stop(runner)).toEqual({ listed: [], failures: ['docker ps failed: Cannot connect to the Docker daemon'] });
    expect(calls).toEqual([ps]);
  });
});
