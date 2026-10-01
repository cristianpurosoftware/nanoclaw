import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isValidGroupFolder } from '../../src/group-folder.js';
import * as setupLog from '../logs.js';
import { classifyPingResult, logFirstChat, pingCliAgent, PING_AGENT_FOLDER } from './agent-ping.js';

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
  logFirstChat('no_reply', 1200);
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'failed', 1200, {
    RESULT: 'no_reply',
    HINT: expect.stringContaining('logs/nanoclaw.log'),
  });
});

it('logs an agent failure as failed with a what-to-do hint', () => {
  logFirstChat('agent_failure', 900);
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'failed', 900, {
    RESULT: 'agent_failure',
    HINT: expect.stringContaining('credentials'),
  });
});

it('logs ok as success without a hint', () => {
  logFirstChat('ok', 500);
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
    await expect(result).resolves.toBe('agent_failure');
  });

  it('reports no_reply when nothing was printed by the deadline', async () => {
    vi.useFakeTimers();
    const result = pingCliAgent(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    await expect(result).resolves.toBe('no_reply');
  });

  it('gives up after the grace period if the client never exits', async () => {
    vi.useFakeTimers();
    const result = pingCliAgent(1000);
    children[0].stdout.emit('data', Buffer.from('pong\n'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    await expect(result).resolves.toBe('no_reply');
  });
});
