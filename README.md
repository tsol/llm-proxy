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
Model aliases and fallback chains are defined there via `MODEL{n}_ALIAS` / `MODEL{n}_TRY`.  
Rate limits and model quirks are in `src/providers/model-metadata.json`.

## Quick Start

```bash
cd ~/hermes
./run.sh start proxy      # Start proxy
./run.sh configure        # Wire Hermes to all 9 providers
./run.sh model            # View catalog with pricing, limits, live quota