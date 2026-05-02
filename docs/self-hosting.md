# Self-hosting R-Searcher

R-Searcher is a browser extension that sends article or text-processing requests to your own Cloudflare Worker deployment. The public open-source setup is self-hosted by default.

## Architecture

- `extension/` is the Chrome extension UI and browser-side request flow.
- `worker/` is the Cloudflare Worker that validates requests and calls the Gemini API.
- The extension does not ship with a hidden shared production backend. You paste your own worker URL into Settings.

## Technical flow

- The extension generates and stores a local `installId`, which the backend can use as a lightweight per-install identity without requiring user accounts.
- `background.js` is the single network gateway inside the extension. It validates the configured HTTPS backend URL, checks host permissions, and proxies calls to the worker.
- For article analysis, `content.js` tries to find the most likely article container first, then removes obvious non-article chrome such as nav blocks, breadcrumbs, sidebars, share widgets, pagination, and promo sections before sending text.
- For inline explanation, the extension sends only the selected fragment instead of the full page.
- Analyze responses are normalized into `Essence`, `Notes`, and `Next Steps` before rendering.
- Explain responses include a small metadata block that controls which follow-up buttons appear in the UI.
- Optional `RATE_LIMIT_KV` is there for deployment hardening, not as a product tier. The worker still runs without it.

## Prerequisites

- A Cloudflare account
- Node.js and npm
- Chrome or another Chromium-based browser for extension loading
- A Gemini API key

## 1. Prepare the worker config

From the repository root:

```bash
cd worker
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml` and set your worker name.

## 2. Install Wrangler and authenticate

```bash
npm install -g wrangler
wrangler login
```

## 3. Set required secrets

The worker requires one secret:

```bash
wrangler secret put AI_API_KEY
```

## 4. Decide whether to use KV

`RATE_LIMIT_KV` is optional in the open-source baseline.

- Without KV: the worker still runs and serves requests.
- With KV: you can enable optional burst throttling and conservative global budget accounting.

If you want KV:

```bash
wrangler kv:namespace create "RATE_LIMIT_KV"
```

Then uncomment the `[[kv_namespaces]]` block in `wrangler.toml` and paste the generated namespace ID.

## 5. Deploy the worker

```bash
wrangler deploy
```

After deployment, Wrangler prints a URL like:

```text
https://your-worker-subdomain.workers.dev
```

That is the base URL you will use in the extension.

## 6. Load the extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension/` folder from this repository

## 7. Point the extension at your worker

1. Open the extension settings page.
2. Paste your deployed worker base URL into `Worker / API base URL`.
3. Save the setting.
4. Accept the browser permission request for that origin if prompted.

The extension will send requests to `POST /process` on your configured base URL.

## Common failure cases

### `Missing or invalid installId`

Reload the extension and retry. The extension should generate and persist its install ID automatically.

### `provider_error`

Check that:

- `AI_API_KEY` was set with `wrangler secret put`
- the key is valid
- the Gemini API is available for your account

### Browser says the backend origin is not allowed

Re-save the backend URL in extension settings so the optional host permission flow can request access for that origin.

### Worker deploys but requests fail immediately

Check `wrangler tail` for logs and confirm the worker URL in extension settings matches the deployed origin exactly.

### You enabled KV but rate limiting behaves unexpectedly

KV-based counters are a deployment hardening option, not a precise billing system. Validate the namespace binding and review the rate-limit logic in `worker/worker.js`.

## Useful commands

```bash
wrangler deploy
wrangler tail
```
