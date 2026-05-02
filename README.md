# R-Searcher

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hdjdfpnogclokhfkdfdkndhneipmkipp?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/r-searcher/hdjdfpnogclokhfkdfdkndhneipmkipp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

R-Searcher is an open-source AI reading assistant for Chrome. It helps you analyze long articles, explain difficult passages, and keep structured notes without leaving the page.

**[→ Install from Chrome Web Store](https://chromewebstore.google.com/detail/r-searcher/hdjdfpnogclokhfkdfdkndhneipmkipp)** · or self-host your own backend using this repository.

The project uses a self-hosted architecture:

- The browser extension handles article extraction, UI, and local settings.
- A Cloudflare Worker handles request validation and model calls.
- You connect the extension to your own deployed worker URL.

## Project structure

```text
extension/          Chrome Extension (Manifest V3, no build step)
worker/             Cloudflare Worker backend
docs/               Self-hosting documentation
```

## How the extension and worker fit together

1. You open an article or select text in the browser.
2. The extension prepares the request and sends it to your configured worker origin.
3. The worker validates input, applies optional abuse controls, and calls Gemini.
4. The worker returns structured results to the extension UI.

The extension does not ship with a hidden shared production backend. In the open-source model, each operator points it at their own deployment.

## Architecture and implementation details

The product shape follows the same core design described in the recent DEV write-up: keep the stack lean, keep the client thin, and let the backend own trust-sensitive decisions.

- `extension/` is a plain Manifest V3 client with no build step, which keeps iteration and debugging fast.
- `background.js` acts as the network boundary. It validates the configured backend URL, checks optional origin permissions, and proxies requests to `POST /process`.
- `content.js` owns page-side behavior: it detects likely article containers, strips obvious page chrome such as nav, breadcrumbs, sidebars, share blocks, and feedback widgets, then sends cleaned text for analysis.
- The extension generates a local `installId` with `crypto.randomUUID()` and stores it in `chrome.storage.local`, so the backend can reason about per-install fairness without a full account system.
- Analyze requests are cached locally by page URL, so reopening the popup on the same article does not feel stateless.
- The analyze flow is built around three structured sections: `Essence`, `Notes`, and `Next Steps`. The worker normalizes model output into that shape before the UI renders it.
- The explain flow returns a short explanation plus a tiny `<<<META>>>` block. That metadata decides which follow-up actions to show, such as rephrase, example, application, or importance.
- The worker is the source of truth for validation and safety. It enforces install ID shape, payload size limits, optional KV-backed burst controls, and optional daily budget accounting before any model call is made.

Current stack:

- Chrome Extension MV3
- Cloudflare Worker
- Optional Cloudflare KV for anti-abuse state
- Gemini 2.5 Flash-Lite as the model backend

This boundary is intentional: the frontend stays reactive and lightweight, while the backend owns request validation, guardrails, and response shaping.

## Quick start

### 1. Deploy the Cloudflare Worker

```bash
cd worker
cp wrangler.toml.example wrangler.toml
npm install -g wrangler
wrangler login
wrangler secret put AI_API_KEY
wrangler deploy
```

If you want optional KV-backed throttling and global budget accounting, create a KV namespace and uncomment the `RATE_LIMIT_KV` block in `worker/wrangler.toml`.

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension/` folder

### 3. Paste your worker URL into extension settings

After deployment, Wrangler prints a base URL such as `https://your-worker-subdomain.workers.dev`.

Open the extension settings page and paste that base URL into `Worker / API base URL`. The extension stores it locally and requests browser permission for that origin.

## Cloudflare Worker setup notes

- Required secret: `AI_API_KEY`
- Optional KV binding: `RATE_LIMIT_KV`
- Main endpoint used by the extension: `POST /process`
- Useful command for logs: `wrangler tail`

Full setup and troubleshooting guide: [docs/self-hosting.md](docs/self-hosting.md)

## Privacy and data flow

- The extension reads page content locally in the browser when you trigger an action.
- The selected text or extracted article content is sent to the worker URL you configured.
- The worker forwards the request to Gemini using your own API key stored in Cloudflare secrets.
- This repository does not require a central hosted service for normal operation.

## Development notes

- `extension/` is plain JavaScript and HTML with no build step.
- `worker/worker.js` contains request validation, prompt building, response normalization, and optional KV-backed safeguards.
- The popup and content script both understand structured analyze results and reuse the same `Essence / Notes / Next Steps` shape.
- This repository focuses on the open-source extension and self-hosted worker flow.
- Do not commit secrets, private account identifiers, or environment-specific URLs.

## Contributing

Contribution guidance lives in [CONTRIBUTING.md](CONTRIBUTING.md).

- Bugs: open a [GitHub issue](../../issues)
- Feature proposals: [GitHub issues or discussions](../../issues)
- Security issues: report privately via [SECURITY.md](SECURITY.md), not in a public issue first

## License

MIT. See [LICENSE](LICENSE).
