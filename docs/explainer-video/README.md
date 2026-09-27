# NanoClaw explainer video

A ~95 second animated explainer of what NanoClaw is and how it works: why it exists, channels,
how a message travels, container isolation, the credential gateway, skills, and quick start.

The whole video is one HTML page (`explainer.html`) driven by CSS animations. Every animation's
delay is an absolute timestamp, so the page is a pure function of time. Open it in a browser
to watch it play live, or render it to MP4:

```bash
node docs/explainer-video/render.mjs nanoclaw-explainer.mp4            # 1920x1080, 30 fps
node docs/explainer-video/render.mjs preview.mp4 --stills              # one PNG per scene
```

Requirements: Playwright with Chromium, and an `ffmpeg` built with libx264 (on `PATH`, or set
`FFMPEG=/path/to/ffmpeg`). Fonts (Nunito, JetBrains Mono) are fetched from Google Fonts at
render time.

To edit a scene, change its markup and the `--s`/`--e` (scene in/out) and `--d` (element
entrance) times in seconds. `window.DURATION` sets the total length.
