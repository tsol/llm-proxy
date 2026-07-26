# LLM Proxy — API Reference

Runs on `http://127.0.0.1:5001` (host) or `http://host.docker.internal:5001` (Docker).  
OpenAI-compatible API that routes requests to 8 upstream providers.

## Endpoints

### Main API (`/v1/`) — Smart Routing

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | Available model aliases (configured via `.env`) |
| `POST` | `/v1/chat/completions` | Standard OpenAI-compatible chat |
| `GET` | `/health` | Health check |

Model aliases are defined via `MODEL{n}_ALIAS` / `MODEL{n}_TRY` in `.env`. Each alias maps to one or more `provider/model` TRY entries — the first successful one wins, the rest serve as automatic fallback.

### Per-Provider Endpoints (`/{provider}/v1/`) — Direct Bypass

**No aliases, no fallback, no filtering.** Every request goes straight to the named provider's upstream API:

| Path | Upstream |
|------|----------|
| `POST /deepseek/v1/chat/completions` | `https://api.deepseek.com/v1` |
| `POST /openrouter/v1/chat/completions` | `https://openrouter.ai/api/v1` |
| `POST /cerebras/v1/chat/completions` | `https://api.cerebras.ai/v1` |
| `POST /groq/v1/chat/completions` | `https://api.groq.com/openai/v1` |
| `POST /google/v1/chat/completions` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `POST /gonka/v1/chat/completions` | `https://proxy.gonka.gg/v1` |
| `POST /local/v1/chat/completions` | `http://localhost:1234/v1` (LM Studio) |
| `POST /cursor/v1/chat/completions` | Cursor SDK |

All per-provider paths support `GET /{provider}/v1/models` returning the provider's full unfiltered catalog.

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/router/status` | All providers with state (live/stale/fallback) and model counts |
| `GET` | `/v1/router/providers` | Provider configs, rate limits, live quota from upstream headers |
| `GET` | `/v1/router/models` | Full catalog with pricing, context lengths, capabilities |
| `POST` | `/v1/router/refresh` | Force catalog refresh from all upstreams |
| `POST` | `/v1/router/default` | Set Hermes default model (`{"model": "some-model"}`) |

## Rate Limits

Configured per-provider via `model-metadata.json` with env overrides (`PROVIDER_TPM`, `PROVIDER_RPM`, `PROVIDER_RPH`, `PROVIDER_RPD`).  
Live quota from upstream `X-RateLimit-*` response headers is tracked in-memory and exposed via `/v1/router/providers`.

## Error Recovery

- **402** (insufficient credits): auto-caps `max_tokens` to affordable amount, retries
- **429 / 413** (rate limited): falls back to next TRY chain entry
- **Timeout / 5xx / network**: falls back to next TRY chain entry

Per-provider endpoints have **no automatic recovery** — they pass through failures directly.

## In Hermes

Smart routing via aliases (uses `/v1/`):
```
/model <alias-name>
```

Direct per-provider routing (uses `/{provider}/v1/`):
```
/model --provider proxy-<provider> <model-id>
```

Available Hermes providers (configured by `./run.sh configure`):  
`proxy`, `proxy-deepseek`, `proxy-openrouter`, `proxy-cerebras`, `proxy-groq`, `proxy-gonka`, `proxy-google`, `proxy-local`, `proxy-cursor`

## Configuration

Copy `.env.example` to `.env` and fill in API keys.  
Rate limits and model quirks are in `src/providers/model-metadata.json`.

### Model Aliases

Aliases map user-facing names to fallback chains of `provider/model` entries. They come from two sources, merged at startup:

1. **`.env` (locked)** — `MODEL{n}_ALIAS` + `MODEL{n}_TRY`. Cannot be changed at runtime.
2. **`store/aliases.json` (user-managed)** — persisted JSON, created and modified via the `/v1/aliases` API.

Env aliases always take precedence. If a store alias has the same name as an env alias, the env one wins.

### Alias Management API

```
GET    /v1/aliases             — list all aliases (locked + user)
GET    /v1/aliases/resolved    — show the merged alias map used by the router
GET    /v1/aliases/:name       — get a single alias by name
POST   /v1/aliases             — create a new user alias
PUT    /v1/aliases/:name       — update an existing user alias (change chain)
DELETE /v1/aliases/:name       — delete a user alias
```

**Locked aliases** (defined in `.env`) return `"locked": true` and cannot be modified or deleted — API returns 403.

**Creating an alias:**

```bash
curl -X POST http://localhost:5001/v1/aliases \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "my-fast-model",
    "chain": ["groq/llama-4-maverick-17b-instruct", "gonka/Kimi-K2.6"]
  }'
```

Response (201):
```json
{
  "alias": "my-fast-model",
  "chain": ["groq/llama-4-maverick-17b-instruct", "gonka/Kimi-K2.6"],
  "locked": false,
  "updated_at": "2026-07-26T15:00:00.000Z"
}
```

**Updating an alias:**

```bash
curl -X PUT http://localhost:5001/v1/aliases/my-fast-model \
  -H "Content-Type: application/json" \
  -d '{
    "chain": ["cerebras/gpt-oss-120b", "deepseek/deepseek-v4-flash"]
  }'
```

**Deleting an alias:**

```bash
curl -X DELETE http://localhost:5001/v1/aliases/my-fast-model
```

**Listing all aliases:**

```bash
curl http://localhost:5001/v1/aliases
```

Response:
```json
{
  "object": "list",
  "data": [
    { "alias": "gemma-4-12b", "chain": ["local/google/gemma-4-12b-qat"], "locked": true },
    { "alias": "my-fast-model", "chain": ["groq/llama-4-maverick-17b-instruct", "gonka/Kimi-K2.6"], "locked": false }
  ]
}
```

After modifying aliases via API, they persist in `store/aliases.json` and survive restarts. No restart needed — the router uses the merged map immediately.

## Quick Start

```bash
cd ~/hermes
./run.sh start proxy      # Start proxy
./run.sh configure        # Wire Hermes to all 9 providers
./run.sh model            # View catalog with pricing, limits, live quota