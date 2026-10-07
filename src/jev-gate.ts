/**
 * Group-chat speak gate: asks TypeSafe Jev whether the bot should wake for
 * the latest group message. Only active when TYPESAFE_API_KEY is set.
 */
import { ASSISTANT_NAME } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

const API_KEY = process.env.TYPESAFE_API_KEY || readEnvFile(['TYPESAFE_API_KEY']).TYPESAFE_API_KEY || '';
const HISTORY = 15;
const ADDRESSED_MIN = 0.5;
const CHIME_MIN = 0.75;
const CHIME_COOLDOWN_MS = 4 * 60_000; // ponytail: fixed knobs, tune after watching the logs

type Line = { who: string; text: string };
const recent = new Map<string, Line[]>();
const lastSpoke = new Map<string, number>();

function push(platformId: string, line: Line): void {
  const lines = recent.get(platformId) ?? [];
  lines.push(line);
  if (lines.length > HISTORY) lines.shift();
  recent.set(platformId, lines);
}

export function jevGateEnabled(): boolean {
  return API_KEY !== '';
}

export function noteInbound(platformId: string, who: string, text: string): void {
  push(platformId, { who, text: text.slice(0, 500) });
}

export function noteOutbound(platformId: string, text: string): void {
  lastSpoke.set(platformId, Date.now());
  if (text) push(platformId, { who: ASSISTANT_NAME, text: text.slice(0, 500) });
}

export async function jevShouldEngage(platformId: string): Promise<boolean> {
  const lines = recent.get(platformId) ?? [];
  const last = lines[lines.length - 1];
  if (!last) return false;
  const nameHit = new RegExp(`\\b${ASSISTANT_NAME}\\b`, 'i').test(last.text);
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: 'jev-latest',
        state: { bot_name: ASSISTANT_NAME, chat: lines.slice(0, -1), last },
        questions: {
          addressed: {
            type: 'noul',
            instructions:
              'This is a WhatsApp group of friends. `bot_name` is one of the members. Is the message in `last` directed at `bot_name`: naming him, asking him something, answering or quoting something he said, or insulting/teasing him directly?',
            criteria: {
              true: '`last` speaks to `bot_name`, so he is expected to answer',
              false: '`last` is part of a conversation between other members, or only talks about `bot_name` in passing',
            },
          },
          chime: {
            type: 'noul',
            instructions:
              'A sharp, teasing friend called `bot_name` has been reading `chat` and `last` without being addressed. Would a real friend jump in right now with a comment?',
            criteria: {
              true: 'There is an obvious joke to make, an open question to the whole group, or the others are talking about `bot_name`',
              false: 'Ordinary back-and-forth between others; a normal friend would just keep reading',
            },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { answers } = (await res.json()) as { answers: Record<string, { noul: number }> };
    const addressed = answers.addressed.noul;
    const chime = answers.chime.noul;
    const cooled = Date.now() - (lastSpoke.get(platformId) ?? 0) > CHIME_COOLDOWN_MS;
    const engage = addressed >= ADDRESSED_MIN || (chime >= CHIME_MIN && cooled);
    log.info('Jev gate', { platformId, addressed, chime, cooled, engage, text: last.text.slice(0, 80) });
    return engage;
  } catch (err) {
    log.warn('Jev gate failed, falling back to name match', { err: String(err), nameHit });
    return nameHit;
  }
}
