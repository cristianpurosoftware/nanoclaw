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

import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import * as setupLog from '../logs.js';
import { wrapForGutter } from './theme.js';

export const PING_AGENT_FOLDER = 'ping_test';

// Longer than chat.ts's SILENCE_MS (2s), so a finished reply gets to exit.
const PING_EXIT_GRACE_MS = 3_000;

export type PingResult = 'ok' | 'no_reply' | 'socket_error' | 'auth_error' | 'agent_failure';

export interface PingOutcome {
  result: PingResult;
  /** The agent's own error line, when its failed run sent one. */
  detail?: string;
}

// The runner's notice when it has no error of its own to report; it tells the
// user nothing, so it is not shown. agent-ping.test.ts pins it to the runner.
export const GENERIC_FAILURE_NOTICE = 'The agent run failed. Check the logs for details.';
const DETAIL_MAX_CHARS = 160;

const PING_HINTS: Record<Exclude<PingResult, 'ok'>, string> = {
  no_reply: 'no reply in time; check logs/nanoclaw.log',
  socket_error: 'service not listening on data/cli.sock; restart it',
  auth_error: 'model credentials rejected; check them',
  agent_failure: 'agent run failed; check the model credentials (a common cause)',
};

// The only setup check that goes through the container, gateway and model.
// Log it so a failed reply isn't hidden behind earlier successes.
export function logFirstChat(outcome: PingOutcome, durationMs: number): void {
  const { result, detail } = outcome;
  if (result === 'ok') {
    setupLog.step('first-chat', 'success', durationMs, { RESULT: result });
    return;
  }
  setupLog.step('first-chat', 'failed', durationMs, { RESULT: result, DETAIL: detail, HINT: PING_HINTS[result] });
}

const AUTH_ERROR_PATTERNS = [
  /Invalid bearer token/i,
  /authentication[_ ]error/i,
  /Failed to authenticate/i,
  /Please run \/login/i,
  /Not logged in/i,
  /Invalid API key/i,
];

export function classifyPingResult(exitCode: number | null, stdout: string, stderr = ''): PingResult {
  const output = `${stdout}\n${stderr}`;
  if (AUTH_ERROR_PATTERNS.some((re) => re.test(output))) return 'auth_error';
  if (exitCode === 2) return 'socket_error';
  if (exitCode === 4) return 'agent_failure';
  if (exitCode === 0 && stdout.trim().length > 0) return 'ok';
  return 'no_reply';
}

const TERMINAL_ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|[\x00-\x1f\x7f-\x9f]/g;
// Long token-like runs (keys, bearer tokens, JWT parts) never belong on screen or in setup.log.
const SECRET_LIKE = /[A-Za-z0-9_\-+=]{24,}/g;

/** Make an agent error line safe to print and log: no escapes, no secrets, short. */
export function sanitizeDetail(line: string): string | undefined {
  const clean = line.replace(TERMINAL_ESCAPES, '').replace(SECRET_LIKE, '[redacted]').trim();
  if (!clean || clean === GENERIC_FAILURE_NOTICE) return undefined;
  return clean.length > DETAIL_MAX_CHARS ? `${clean.slice(0, DETAIL_MAX_CHARS - 1)}…` : clean;
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * The reason to show for a failed ping. ncl prints failure notices on stderr,
 * so a partial reply on stdout is never mistaken for the error.
 */
export function failureDetail(result: PingResult, stdout: string, stderr: string): string | undefined {
  if (result === 'agent_failure') return sanitizeDetail(lines(stderr)[0] ?? '');
  if (result === 'auth_error') {
    const hit = [...lines(stderr), ...lines(stdout)].find((l) => AUTH_ERROR_PATTERNS.some((re) => re.test(l)));
    return hit ? sanitizeDetail(hit) : undefined;
  }
  return undefined;
}

function toOutcome(result: PingResult, stdout: string, stderr: string): PingOutcome {
  const detail = failureDetail(result, stdout, stderr);
  return detail ? { result, detail } : { result };
}

export function pingCliAgent(timeoutMs = 30_000): Promise<PingOutcome> {
  return new Promise((resolve) => {
    // --silent keeps pnpm's banner out of stdout, which holds only the reply.
    const child = spawn('pnpm', ['--silent', 'run', 'chat', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let graceUsed = false;
    // A reply or notice already printed means chat.ts is in its 2s silence
    // wait; let it exit so its code (0 vs 4) still decides the result.
    const onTimeout = () => {
      if (settled) return;
      if (!graceUsed && `${stdout}${stderr}`.trim().length > 0) {
        graceUsed = true;
        timer = setTimeout(onTimeout, PING_EXIT_GRACE_MS);
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      resolve(toOutcome(classifyPingResult(null, stdout, stderr), stdout, stderr));
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
      resolve(toOutcome(classifyPingResult(code, stdout, stderr), stdout, stderr));
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ result: 'socket_error' });
    });
  });
}

export interface PingFailureCopy {
  spinner: string;
  note: string;
  assistMsg: string;
  assistHint: string;
}

/** Wizard text for a failed ping; shows the agent's own error when it sent one. */
export function pingFailureCopy({ result, detail }: PingOutcome): PingFailureCopy {
  if (result === 'socket_error') {
    return {
      spinner: "Couldn't reach the NanoClaw service.",
      note: [
        wrapForGutter(
          "The NanoClaw service isn't listening on its local socket. Try restarting it, then chat with `pnpm run chat hi`:",
          6,
        ),
        '',
        `  macOS:  launchctl kickstart -k gui/$(id -u)/${getLaunchdLabel()}`,
        `  Linux:  systemctl --user restart ${getSystemdUnit()}`,
      ].join('\n'),
      assistMsg: "NanoClaw service isn't listening on its CLI socket.",
      assistHint: 'Socket at data/cli.sock did not accept a connection.',
    };
  }
  if (result === 'agent_failure' || result === 'auth_error') {
    const reason = detail ? `It said: "${detail}".` : 'It sent no reason.';
    return {
      spinner: 'Your assistant started, but its run failed.',
      note: wrapForGutter(
        `Your assistant's run failed. ${reason} Wrong or expired model credentials are a common cause: check them, then try \`pnpm run chat hi\`.`,
        6,
      ),
      assistMsg: 'The assistant replied with a failure notice instead of an answer.',
      assistHint: detail
        ? `The agent's error: ${detail}`
        : 'The agent run failed without a reason; wrong or expired model credentials are a common cause.',
    };
  }
  return {
    spinner: "Your assistant didn't reply in time.",
    note: wrapForGutter(
      'No reply from your assistant within 30 seconds. Check `logs/nanoclaw.log` for clues, then try `pnpm run chat hi`.',
      6,
    ),
    assistMsg: 'No reply from the assistant within 30 seconds.',
    assistHint: 'Agent container may be failing to start or authenticate.',
  };
}
