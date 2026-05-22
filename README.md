# quelora-widget-community

**The embeddable Quelora engagement widget.**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

An offline-first, modular community widget written in ES6+. Drop it into any
web page with a `<script>` tag to add comments, likes, profiles, follows,
notifications and more — powered by the [Quelora](https://github.com/Quelora)
backend.

## Highlights

- **Three execution contexts** — Main Thread (UI), Web Worker (network + data),
  Service Worker (push + offline cache)
- **Offline-first** — in-memory, IndexedDB and optional P2P fallback layers
- **WASM-accelerated** — image processing and Markdown parsing run in WebAssembly
- **Modular** — comments, posts, profiles, registration, notifications, mentions, audio
- **12 languages** — automatic locale detection
- **Plugin system** — enterprise modules are lazy-loaded; Community Edition skips them silently
- **~300–350 KB** gzipped, fully featured

## Integration

```html
<script>
  window.QUELORA_CONFIG = {
    cid: 'QU-XXXXXXXX-XXXXX',
    apiUrl: 'https://api.example.com'
  };
</script>
<script type="module" src="./dist/quelora.js"></script>
```

## Build

Built with Rollup (`js/rollup.dir.config.js`) — two parallel builds for the
main app and the Web Worker, with aggressive minification and tree-shaking of
debug code.

```bash
npm install
npm run build
```

## Architecture

Talks to [`quelora-public-api`](https://github.com/Quelora/quelora-public-api).
Enterprise client modules (P2P, chat, SSE, live, gamification, surveys) ship
separately in
[`quelora-widget-enterprise`](https://github.com/Quelora/quelora-widget-enterprise).
WASM modules are built from
[`quelora-wasm`](https://github.com/Quelora/quelora-wasm).

## License

[AGPL-3.0-only](./LICENSE) — Copyright (C) 2026 Germán Zelaya.

Part of the **[Quelora](https://github.com/Quelora)** project.
