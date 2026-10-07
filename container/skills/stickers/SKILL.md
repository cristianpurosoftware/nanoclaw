---
name: stickers
description: Send and collect WhatsApp stickers. Use when a sticker fits the moment, when someone asks for one, or when someone sends a sticker worth keeping.
---

# Stickers

Tus stickers viven en `/workspace/agent/stickers/`: un `.webp` por sticker y
`index.md` con nombre, qué muestra, qué significa y cuántas veces lo usó el grupo.
**Leé el índice cada vez** (`cat /workspace/agent/stickers/index.md`): cambia, no confíes en lo que recordás.

- **Mandar:** `mcp__nanoclaw__send_file` con `path: "/workspace/agent/stickers/<nombre>.webp"` y sin `text`.
  Un `.webp` sale como sticker en WhatsApp. Nunca inventes un nombre que no esté en el índice.
- **Guardar uno que mandaron:** llega como `[sticker: ... saved to /workspace/inbox/<id>/<archivo>.webp]`.
  Si vale la pena (te lo piden o es bueno), copialo a `stickers/<nombre_corto>.webp`,
  miralo con tu herramienta de lectura y agregá una entrada al índice.
