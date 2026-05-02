# Worker

This directory contains the Cloudflare Worker backend used by the R-Searcher extension.

## What it does

- Accepts extension requests at `POST /process`
- Validates payload shape and request size
- Applies optional KV-backed abuse controls if configured
- Calls Gemini and returns structured results to the extension
- Normalizes analyze responses into `Essence`, `Notes`, and `Next Steps`
- Returns explain metadata that the extension uses to choose follow-up actions

## Setup

1. Copy `wrangler.toml.example` to `wrangler.toml`
2. Set your worker name
3. Run `wrangler secret put AI_API_KEY`
4. Optionally configure `RATE_LIMIT_KV`
5. Run `wrangler deploy`

Detailed step-by-step instructions live in [docs/self-hosting.md](../docs/self-hosting.md).
