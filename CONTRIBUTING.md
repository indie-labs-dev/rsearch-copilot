# Contributing

Thanks for helping improve R-Searcher.

## Before you start

- Read the setup flow in [README.md](README.md) and [docs/self-hosting.md](docs/self-hosting.md).
- Keep changes aligned with the current self-hosted architecture: browser extension + Cloudflare Worker backend.
- If you plan a large change, open an issue or discussion first.

## Good first contribution areas

- Extension UX fixes in `extension/`
- Worker reliability, validation, or deployment docs in `worker/`
- Self-hosting documentation cleanup in `docs/`
- Reliability, extraction quality, and prompt-shaping improvements across the extension/worker boundary

## Development workflow

1. Fork the repository and create a feature branch.
2. Copy `worker/wrangler.toml.example` to `worker/wrangler.toml`.
3. Set the required worker secret with `wrangler secret put AI_API_KEY`.
4. Load the unpacked extension from `extension/` and point it at your deployed worker URL in Settings.

## Change guidelines

- Keep secrets, personal keys, and account-specific IDs out of git.
- Prefer small pull requests with a clear user-facing goal.
- Update docs when behavior or setup changes.
- Preserve optional deployment choices as optional. For example, KV-backed abuse controls should stay documented as deployment hardening, not as a required product tier.
- If you change extension strings, keep the wording consistent across `options.html`, `i18n.js`, and any related docs.

## Pull request checklist

- Explain what changed and why.
- Include reproduction steps for bug fixes.
- Note any manual verification you performed.
- Call out config or migration impact.
- Add or update docs if setup, deployment, or user-facing behavior changed.

## Reporting bugs and requesting features

- Reproducible bugs: open a [GitHub issue](../../issues).
- Feature requests and product feedback: use [GitHub discussions or issues](../../issues).
- Security issues: follow [SECURITY.md](SECURITY.md) and do not open a public issue first.
