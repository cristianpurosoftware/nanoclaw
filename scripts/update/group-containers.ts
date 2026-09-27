/**
 * Stop and remove every runtime container of one agent group folder, matched by
 * the install label plus the folder label composition stamps on the session
 * container and its auxiliaries. The folder, unlike the group id, is known from
 * the command line alone, so a re-run after the group's rows are gone still
 * finds a leftover. `ps -a` also catches exited containers.
 *
 * Never throws: an unreachable daemon or missing binary comes back as a failure.
 */
import { GROUP_FOLDER_LABEL, LABELS } from '../../src/drivers/types.js';
import { CUTOVER_STOP_CLI_TIMEOUT_MS, CUTOVER_STOP_GRACE_SECONDS, type CommandRunner } from './service.js';

export interface StopGroupContainersOptions {
  runtime: string;
  installSlug: string;
  folder: string;
  runner: CommandRunner;
}

export interface StopGroupContainersResult {
  /** Container ids the runtime listed for the folder (possibly none). */
  listed: string[];
  /** Human-readable failures, one per step that did not succeed. Empty on a clean run. */
  failures: string[];
}

export function stopGroupContainers(options: StopGroupContainersOptions): StopGroupContainersResult {
  const { runtime, installSlug, folder, runner } = options;
  const filters = [
    '--filter',
    `label=${LABELS.install}=${installSlug}`,
    '--filter',
    `label=${GROUP_FOLDER_LABEL}=${folder}`,
  ];
  const opts = { timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS };
  const listed = runner.tryRun(runtime, ['ps', '-aq', ...filters], undefined, opts);
  if (!listed.ok) return { listed: [], failures: [`${runtime} ps failed: ${listed.stdout || 'no output'}`] };
  const ids = listed.stdout.split('\n').filter(Boolean);
  if (ids.length === 0) return { listed: ids, failures: [] };

  const stopped = runner.tryRun(runtime, ['stop', '-t', String(CUTOVER_STOP_GRACE_SECONDS), ...ids], undefined, opts);
  // `--rm` sessions vanish on stop, so rm usually reports "No such container".
  // A successful `rm --force` has removed every id whatever the stop did;
  // otherwise only what the runtime still lists afterwards matters.
  const removed = runner.tryRun(runtime, ['rm', '--force', ...ids], undefined, opts);
  if (removed.ok) return { listed: ids, failures: [] };

  const remaining = runner.tryRun(runtime, ['ps', '-aq', ...filters], undefined, opts);
  if (!remaining.ok) return { listed: ids, failures: [`${runtime} ps failed: ${remaining.stdout || 'no output'}`] };
  const survivors = remaining.stdout.split('\n').filter(Boolean);
  if (survivors.length === 0) return { listed: ids, failures: [] };
  const failures: string[] = [];
  if (!stopped.ok) failures.push(`${runtime} stop failed: ${stopped.stdout || 'no output'}`);
  failures.push(`${runtime} rm failed: ${removed.stdout || 'no output'}`);
  failures.push(`still listed: ${survivors.join(', ')}`);
  return { listed: ids, failures };
}
