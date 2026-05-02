# Worker Patterns

## Request handling
- Always check CORS - extension origin must be allowed
- Rate limit key format: `{ip}:{mode}:{utc-date}` - expires at next UTC midnight
- Return structured JSON: `{ result, error, rateLimitRemaining }`

## KV rate limiting pattern
```js
const key = `${ip}:${mode}:${utcDate}`;
const count = parseInt(await env.RATE_LIMIT_KV.get(key) || '0');
if (count >= DAILY_LIMIT) return limitExceededResponse();
await env.RATE_LIMIT_KV.put(key, String(count + 1), { expiration: nextMidnightUnix });
```

## Gemini call
- Model: gemini-2.5-flash-lite
- API key from `env.AI_API_KEY` - never hardcode
- Always handle non-200 responses from Gemini explicitly

## Gotchas
- KV `get` returns null (not 0) if key missing - always parseInt with fallback
- `expiration` in KV.put is Unix timestamp (seconds), not TTL
- Worker handles both explain (selected text) and analyze (full page) modes - check `mode` param
- wrangler.toml KV binding name must match `env.RATE_LIMIT_KV` in code exactly

## Deploy
```bash
wrangler deploy
wrangler secret put AI_API_KEY   # only when rotating key
wrangler tail                    # live logs for debugging
```