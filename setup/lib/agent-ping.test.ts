import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isValidGroupFolder } from '../../src/group-folder.js';
import * as setupLog from '../logs.js';
import {
  classifyPingResult,
  failureDetail,
  sanitizeDetail,
  GENERIC_FAILURE_NOTICE,
  logFirstChat,
  pingCliAgent,
  pingFailureCopy,
  PING_AGENT_FOLDER,
} from './agent-ping.js';

vi.mock('../logs.js', () => ({ step: vi.fn() }));

const { children } = vi.hoisted(() => ({ children: [] as FakeChild[] }));
vi.mock('child_process', () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    children.push(child);
    return child;
  },
}));
type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };

it('uses a runtime-safe folder for the setup ping agent', () => {
  expect(isValidGroupFolder(PING_AGENT_FOLDER)).toBe(true);
});

describe('classifyPingResult', () => {
  it('treats a normal text reply as ok', () => {
    expect(classifyPingResult(0, 'pong\n')).toBe('ok');
  });

  it('detects Anthropic auth errors printed as a chat reply', () => {
    expect(
      classifyPingResult(
        0,
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
      ),
    ).toBe('auth_error');
  });

  it('detects auth errors on stderr too', () => {
    expect(classifyPingResult(1, '', 'Authentication error')).toBe('auth_error');
  });

  it('detects Claude Code login banners printed as a chat reply', () => {
    expect(classifyPingResult(0, 'Invalid API key · Please run /login')).toBe('auth_error');
    expect(classifyPingResult(0, 'Not logged in · Please run /login')).toBe('auth_error');
  });

  it('preserves socket errors', () => {
    expect(classifyPingResult(2, '')).toBe('socket_error');
  });

  it('treats empty output as no reply', () => {
    expect(classifyPingResult(0, '')).toBe('no_reply');
    expect(classifyPingResult(0, '  \n')).toBe('no_reply');
  });

  it('treats a failure notice (chat exit 4) as an agent failure, not ok', () => {
    expect(classifyPingResult(4, 'The agent run failed. Check the logs for details.\n')).toBe('agent_failure');
  });

  it('keeps auth_error for a failure notice that names an auth problem', () => {
    expect(classifyPingResult(4, 'Invalid API key · Please run /login')).toBe('auth_error');
  });
});

it('logs the first-chat ping result to setup.log', () => {
  logFirstChat({ result: 'no_reply' }, 1200);
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'failed', 1200, {
    RESULT: 'no_reply',
    HINT: expect.stringContaining('logs/nanoclaw.log'),
  });
});

it('logs an agent failure with its reason and a what-to-do hint', () => {
  logFirstChat({ result: 'agent_failure', detail: 'quota exceeded' }, 900);
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'failed', 900, {
    RESULT: 'agent_failure',
    DETAIL: 'quota exceeded',
    HINT: expect.stringContaining('credentials'),
  });
});

it('logs ok as success without a hint', () => {
  logFirstChat({ result: 'ok' }, 500);
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'success', 500, { RESULT: 'ok' });
});

describe('pingCliAgent timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    children.length = 0;
  });

  it('lets a reply printed just before the deadline exit with its own code', async () => {
    vi.useFakeTimers();
    const result = pingCliAgent(1000);
    const child = children[0];
    child.stdout.emit('data', Buffer.from('The agent run failed. Check the logs for details.\n'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 4);
    await expect(result).resolves.toEqual({ result: 'agent_failure' });
  });

  it('reports no_reply when nothing was printed by the deadline', async () => {
    vi.useFakeTimers();
    const result = pingCliAgent(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    await expect(result).resolves.toEqual({ result: 'no_reply' });
  });

  it('gives up after the grace period if the client never exits', async () => {
    vi.useFakeTimers();
    const result = pingCliAgent(1000);
    children[0].stdout.emit('data', Buffer.from('pong\n'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    await expect(result).resolves.toEqual({ result: 'no_reply' });
  });
});

describe('failure detail', () => {
  it('takes the notice from stderr, not a partial reply on stdout', () => {
    expect(
      failureDetail('agent_failure', 'Finished the first step.\n', '403 billing_error: Spending limit reached.\n'),
    ).toBe('403 billing_error: Spending limit reached.');
  });

  it('hides the generic notice, which carries no reason', () => {
    expect(failureDetail('agent_failure', '', `${GENERIC_FAILURE_NOTICE}\n`)).toBeUndefined();
    expect(failureDetail('agent_failure', '', '')).toBeUndefined();
  });

  it('uses the matching line for an auth error on either stream', () => {
    expect(failureDetail('auth_error', '', 'Authentication error: invalid account\n')).toBe(
      'Authentication error: invalid account',
    );
    expect(failureDetail('auth_error', 'hello\nInvalid API key · Please run /login\n', '')).toBe(
      'Invalid API key · Please run /login',
    );
  });

  it('strips terminal escapes and redacts token-like strings', () => {
    expect(sanitizeDetail('\x1b]52;c;VEVTVA==\x07\x1b[31mInvalid API key\x1b[0m')).toBe('Invalid API key');
    expect(sanitizeDetail('Rejected: Bearer synthetic-review-token-0123456789')).toBe('Rejected: Bearer [redacted]');
  });

  it('truncates a long line', () => {
    const detail = sanitizeDetail('word '.repeat(100));
    expect(detail).toHaveLength(160);
    expect(detail?.endsWith('…')).toBe(true);
  });

  it('matches the runner constant', () => {
    const runner = fs.readFileSync(path.join(process.cwd(), 'container/agent-runner/src/formatter.ts'), 'utf-8');
    expect(runner.match(/export const GENERIC_FAILURE_NOTICE = '([^']+)'/)?.[1]).toBe(GENERIC_FAILURE_NOTICE);
  });

  it('is attached to the outcome of a failed ping', async () => {
    const result = pingCliAgent(1000);
    const child = children[children.length - 1];
    child.stderr.emit('data', Buffer.from('Credit balance is too low\n'));
    child.emit('close', 4);
    await expect(result).resolves.toEqual({ result: 'agent_failure', detail: 'Credit balance is too low' });
  });
});

describe('wizard failure copy', () => {
  // The note is wrapped to the terminal width; compare it as one line.
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  it("shows the agent's own error and no log pointer", () => {
    const copy = pingFailureCopy({ result: 'agent_failure', detail: 'Credit balance is too low' });
    expect(flat(copy.note)).toContain('It said: "Credit balance is too low".');
    expect(copy.assistHint).toContain('Credit balance is too low');
    expect(flat(copy.note)).not.toContain('logs/nanoclaw.log');
  });

  it('says no reason was sent for the generic notice', () => {
    const copy = pingFailureCopy({ result: 'agent_failure' });
    expect(flat(copy.note)).toContain('It sent no reason.');
    expect(flat(copy.note)).not.toContain('logs/nanoclaw.log');
  });
});
