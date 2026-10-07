// Transcribes an audio file with mimo-v2.6-flash on OpenCode Go.
// The gateway injects the real key for opencode.ai; the bearer here is a placeholder.
const file = process.argv[2];
if (!file) throw new Error('usage: transcribe.ts <audio file>');
const ext = file.split('.').pop()!.toLowerCase();
const format = ({ opus: 'ogg', oga: 'ogg', m4a: 'mp4', mpeg: 'mp3' } as Record<string, string>)[ext] ?? ext;
const data = Buffer.from(await Bun.file(file).arrayBuffer()).toString('base64');

const res = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer placeholder',
    'x-opencode-session': `transcribe-${Date.now()}`,
  },
  body: JSON.stringify({
    model: 'mimo-v2.6-flash',
    thinking: { type: 'disabled' },
    max_tokens: 2000,
    messages: [
      { role: 'system', content: 'Sos un transcriptor. Respondé solo con la transcripción literal, en el idioma original.' },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data, format } }] },
    ],
  }),
});
const body = (await res.json()) as any;
const text = body?.choices?.[0]?.message?.content;
if (!res.ok || !text) {
  console.error(`transcription failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  process.exit(1);
}
console.log(text.trim());
