// Reads an X/Twitter post through the public fxtwitter API (no login).
const url = process.argv[2] ?? '';
const id = url.match(/status(?:es)?\/(\d+)/)?.[1];
if (!id) throw new Error('usage: xlink.ts <x.com/.../status/ID url>');

const res = await fetch(`https://api.fxtwitter.com/status/${id}`);
const { tweet } = (await res.json()) as any;
if (!res.ok || !tweet) {
  console.error(`could not read post ${id} (${res.status})`);
  process.exit(1);
}

const describe = (t: any) => `@${t.author?.screen_name} (${t.author?.name}): ${t.text}`;
console.log(describe(tweet));
if (tweet.quote) console.log(`  citando a ${describe(tweet.quote)}`);
console.log(`likes: ${tweet.likes ?? '?'} · fecha: ${tweet.created_at ?? '?'}`);

const media = tweet.media?.all ?? [];
for (const [i, m] of media.entries()) {
  if (m.type !== 'photo') {
    console.log(`media ${i + 1}: ${m.type} ${m.url}`);
    continue;
  }
  const path = `/workspace/agent/tmp/x-${id}-${i + 1}.jpg`;
  await Bun.write(path, await (await fetch(m.url)).arrayBuffer());
  console.log(`foto ${i + 1}: ${path}`);
}
