---
name: transcribe-audio
description: Transcribe a voice note or audio file to text. Use whenever a message brings an audio attachment ([audio: ... saved to /workspace/inbox/...]) — read what they said before deciding how to answer.
---

# Transcribir audios

```bash
bun /app/skills/transcribe-audio/transcribe.ts /workspace/inbox/<message-id>/<archivo>
```

Imprime solo la transcripción. Tratala como si la persona lo hubiera escrito.
Si falla, decí que no se escuchó bien, a tu manera; no inventes lo que dijo.
