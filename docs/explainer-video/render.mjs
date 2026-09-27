// Render explainer.html to an MP4 by seeking its CSS timeline frame by frame.
//
//   node docs/explainer-video/render.mjs [out.mp4] [--fps 30] [--stills]
//
// Needs Playwright (Chromium) and an ffmpeg with libx264 on PATH, or set FFMPEG=/path/to/ffmpeg.
// --stills writes one PNG per scene instead of a video, for a quick visual check.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  const globalRoot = execFileSync('npm', ['root', '-g']).toString().trim();
  ({ chromium } = require(path.join(globalRoot, 'playwright')));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const fps = Number(flag('--fps', 30));
const stills = args.includes('--stills');
const out = path.resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--fps')) ?? 'nanoclaw-explainer.mp4');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';

// Chromium does not see the system CA bundle, so fetch Google Fonts with curl and
// serve them to the page ourselves.
const fetchBuf = (url) => execFileSync('curl', ['-sSfL', '-A', 'Mozilla/5.0 Chrome/120', url], { maxBuffer: 1 << 26 });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
  const url = route.request().url();
  try {
    const body = fetchBuf(url);
    const contentType = url.includes('googleapis') ? 'text/css' : 'font/woff2';
    await route.fulfill({ body, contentType });
  } catch {
    await route.abort();
  }
});
await page.goto(pathToFileURL(path.join(here, 'explainer.html')).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);

if (stills) {
  const times = [4, 15, 27, 41, 48, 58, 71, 83, 89.8, 94];
  for (const t of times) {
    await page.evaluate((t) => window.seek(t), t);
    await page.screenshot({ path: `${out.replace(/\.mp4$/, '')}-${String(t).replace('.', '_')}.png` });
  }
  await browser.close();
  process.exit(0);
}

const enc = spawn(ffmpeg, [
  '-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  out,
], { stdio: ['pipe', 'inherit', 'inherit'] });

const frames = Math.round(duration * fps);
for (let f = 0; f < frames; f++) {
  await page.evaluate((t) => window.seek(t), f / fps);
  const jpg = await page.screenshot({ type: 'jpeg', quality: 95 });
  if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once('drain', r));
  if (f % (fps * 5) === 0) process.stdout.write(`\r${(f / fps).toFixed(0)}s / ${duration}s`);
}
enc.stdin.end();
await new Promise((r, j) => enc.on('close', (c) => (c === 0 ? r() : j(new Error(`ffmpeg exited ${c}`)))));
await browser.close();
console.log(`\nwrote ${out}`);
