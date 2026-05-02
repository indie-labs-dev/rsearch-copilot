# Research Copilot
Chrome Extension MV3 + Cloudflare Worker. Vanilla JS, no build step.

## Stack
Extension: Vanilla JS, MV3, no bundler
Backend: Cloudflare Worker, Wrangler, KV rate limiting
AI: Gemini 2.5 Flash-Lite via worker proxy

## Structure
extension/ - popup.js, content.js, background.js, options.js, i18n.js, content.css
worker/    - worker.js, wrangler.toml

## Hard rules
- Extension never calls Gemini directly - always via WORKER_URL in content.js
- API key in Cloudflare secret only - never in extension code
- User-visible strings -> i18n.js - never hardcode
- No external libs in extension/

## Gotchas
- manifest.json host_permissions must match WORKER_URL exactly or requests blocked silently
- After editing worker.js -> always ask before deploying, never auto-deploy
- content.js runs on ALL urls -> guard DOM queries, can return null
- chrome.storage is async -> always await, never read synchronously
- MV3 service worker (background.js) can be killed anytime -> never store state in memory

## Git
Conventional commits: feat/fix/chore/docs. MR to main only.

## Skills
@.Codex/skills/extension.md - content script, popup, messaging patterns
@.Codex/skills/worker.md    - rate limiting, KV, Gemini call patterns