/**
 * Round-trip check against the CLI Unix socket.
 *
 * Used by `setup/auto.ts` to confirm the freshly-wired agent actually
 * responds before prompting the user to chat with it.
 *
 * Exit-code contract follows `scripts/chat.ts`:
 *   0  → got a reply on stdout
 *   2  → socket unreachable (service not running or wrong checkout)
 *   3  → no reply before chat.ts's own 120s hard stop
 *   4  → the reply was the runner's failure notice (the agent run failed)
 * This wrapper also guards with its own timeout in case chat.ts hangs.
 */
import { spawn } from 'child_process';

import * as setupLog from '../logs.js';

export const PING_AGENT_FOLDER = 'ping_test';

// Longer than chat.ts's SILENCE_MS (2s), so a finished reply gets to exit.
const PING_EXIT_GRACE_MS = 3_000;

export type PingResult = 'ok' | 'no_reply' | 'socket_error' | 'auth_error' | 'agent_failure';

const PING_HINTS: Record<Exclude<PingResult, 'ok'>, string> = {
  no_reply: 'no reply in time; check logs/nanoclaw.log',
  socket_error: 'service not listening on data/cli.sock; restart it',
  auth_error: 'model credentials rejected; check them, then logs/nanoclaw.log',
  agent_failure: 'agent run failed; see logs/nanoclaw.log (model credentials are a common cause)',
};

// The only setup check that goes through the container, gateway and model.
// Log it so a failed reply isn't hidden behind earlier successes.
export function logFirstChat(result: PingResult, durationMs: number): void {
  if (result === 'ok') {
    setupLog.step('first-chat', 'success', durationMs, { RESULT: result });
    return;
  }
  setupLog.step('first-chat', 'failed', durationMs, { RESULT: result, HINT: PING_HINTS[result] });
}

export function classifyPingResult(exitCode: number | null, stdout: string, stderr = ''): PingResult {
  const output = `${stdout}\n${stderr}`;
  if (
    /Invalid bearer token/i.test(output) ||
    /authentication[_ ]error/i.test(output) ||
    /Failed to authenticate/i.test(output) ||
    /Please run \/login/i.test(output) ||
    /Not logged in/i.test(output) ||
    /Invalid API key/i.test(output)
  ) {
    return 'auth_error';
  }
  if (exitCode === 2) return 'socket_error';
  if (exitCode === 4) return 'agent_failure';
  if (exitCode === 0 && stdout.trim().length > 0) return 'ok';
  return 'no_reply';
}

export function pingCliAgent(timeoutMs = 30_000): Promise<PingResult> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['run', 'chat', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let graceUsed = false;
    // A reply already printed means chat.ts is in its 2s silence wait; let it
    // exit so its code (0 vs 4) still decides the result.
    const onTimeout = () => {
      if (settled) return;
      if (!graceUsed && stdout.trim().length > 0) {
        graceUsed = true;
        timer = setTimeout(onTimeout, PING_EXIT_GRACE_MS);
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      resolve(classifyPingResult(null, stdout, stderr));
    };
    let timer = setTimeout(onTimeout, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(classifyPingResult(code, stdout, stderr));
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('socket_error');
    });
  });
}
