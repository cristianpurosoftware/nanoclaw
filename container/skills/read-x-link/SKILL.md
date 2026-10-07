---
name: read-x-link
description: Read a tweet/post from an x.com or twitter.com link (text, author, quoted post, photos). Use whenever someone shares an X/Twitter link — open it before reacting to it.
---

# Leer links de X

```bash
bun /app/skills/read-x-link/xlink.ts 'https://x.com/usuario/status/123...'
```

Imprime autor, texto, el post citado si hay, y descarga las fotos a
`/workspace/agent/tmp/` (imprime las rutas). Si te interesa la foto, leela
con tu herramienta de lectura de archivos para verla.
