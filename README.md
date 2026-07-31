# LLM Proxy — OpenAI-compatible smart routing with fallback chains

A high-performance (2ms `/v1/models`), zero-dependency-on-external-services proxy that sits between any OpenAI-compatible client and 8 upstream LLM providers — with automatic fallback, garbage detection, rate-limit recovery, and per-provider bypass endpoints.

## Philosophy

**Root `/v1/` endpoint = only aliases, no raw upstream models.**  
Aliases are the "public API" of the proxy. Each alias is a named fallback chain: when the first provider fails (rate limit, garbage, 5xx, timeout), the proxy silently retries the next one in the chain. This gives your agent/application resilience without changing any client code.

**Per-provider `/{provider}/v1/` endpoints = direct bypass, raw upstream catalog.**  
No aliases, no fallback, no filtering — every request goes straight through.

## Architecture

```
Client (OpenAI SDK / curl)
  │
  ├── /v1/models              → Only aliases (fallback-chain entries)
  ├── /v1/chat/completions    → Alias → resolve to provider → forward
  │                              └─ Failure → next in chain
  │
  ├── /gonka/v1/models        → Raw upstream model catalog
  ├── /gonka/v1/chat/completions → Direct forward, no fallback
  ├── /deepseek/v1/...        → Same
  └── ...all 8 providers
```

## Supported Providers (8)

| Provider | Chat URL | Supports |
|----------|---------|----------|
| **Gonka** | `/gonka/v1/` | Kimi-K2.6, MiniMax-M2.7, Qwen3-235B — garbage detection enabled |
| **DeepSeek** | `/deepseek/v1/` | v4-flash (1M context), v4-pro, cache billing |
| **Google** | `/google/v1/` | Gemini 2.0/2.5 flash, flash-image, pro |
| **Cursor** | `/cursor/v1/` | Composer 2.5 via Cursor SDK (200K context) |
| **Groq** | `/groq/v1/` | Llama-4-Maverick (free tier, fast) |
| **Cerebras** | `/cerebras/v1/` | GPT-OSS-120B (ultra-fast) |
| **OpenRouter** | `/openrouter/v1/` | Multi-model gateway (402 credit auto-cap) |
| **Local** | `/local/v1/` | LM Studio — Gemma-4-12B, GPU lifecycle |

## Quick Start

```bash
cp .env.example .env
# Fill in API keys (or leave blank to disable that provider)
npm install
npx tsx src/index.ts
```

**Custom config path** (`PROXY_ENV_FILE` env var, set before launch):

```bash
# Point to a config file outside the project root
PROXY_ENV_FILE="$HOME/hermes/.env-proxy" npx tsx src/index.ts

# Or with the built JS
PROXY_ENV_FILE="$HOME/hermes/.env-proxy" node dist/index.js

# Without PROXY_ENV_FILE, defaults to ../.env (i.e. workspace/code/proxy/.env)
```

```bash
# List available aliases
curl http://localhost:5001/v1/models | jq .

# Chat with an alias (auto-fallback on failure)
curl -s http://localhost:5001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'

# Direct provider bypass (no fallback)
curl -s http://localhost:5001/deepseek/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
```

## API Reference

### Main (`/v1/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | Aliases only — what your agent/client sees |
| `GET` | `/v1/models/:id` | Single alias detail (id, provider, upstream, pricing) |
| `POST` | `/v1/chat/completions` | Chat with alias → fallback chain on failure |
| `GET` | `/health` | Health check |

### Per-Provider (`/{provider}/v1/`)

All 8 providers support `GET /{provider}/v1/models` and `POST /{provider}/v1/chat/completions` — no aliases, no fallback, direct pass-through.

### Aliases (`/v1/aliases`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/aliases` | List all (locked + user-managed) |
| `GET` | `/v1/aliases/resolved` | Merged alias map active in router |
| `GET` | `/v1/aliases/:name` | Single alias detail |
| `POST` | `/v1/aliases` | Create user alias (persisted to `store/aliases.json`) |
| `PUT` | `/v1/aliases/:name` | Update alias chain |
| `DELETE` | `/v1/aliases/:name` | Delete user alias |

```bash
# Create a new alias with fallback chain
curl -X POST http://localhost:5001/v1/aliases \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "my-fast-model",
    "chain": ["groq/llama-4-maverick-17b-instruct", "gonka/Kimi-K2.6"]
  }'
```

Locked aliases (from `.env`) show `"locked": true` — cannot be modified via API.

### Admin (`/v1/router/*`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/router/status` | Provider states (live/stale/fallback) + model counts |
| `GET` | `/v1/router/providers` | Provider configs, rate limits, live quota headers |
| `GET` | `/v1/router/models` | Full catalog: pricing, context lengths, capabilities |
| `POST` | `/v1/router/refresh` | Force catalog refresh from all upstreams |
| `POST` | `/v1/router/default` | Set default model `{"model":"kimi"}` |

## Error Recovery

| Failure | Behavior |
|---------|----------|
| **429 / 413** (rate limit) | Falls back to next alias chain entry |
| **5xx / timeout / network** | Falls back to next alias chain entry |
| **402** (insufficient credits) | Auto-caps `max_tokens`, retries same provider |
| **Gonka garbage** | Detected client-side on streaming output → fallback |
| **All fallbacks exhausted** | Returns 502 with error |

Per-provider paths have **no fallback** — they return upstream errors directly.

## Configuration

### Config file location

The proxy reads its `.env` config **at module-load time** (before any config values are computed).

1. **Default** — `../.env` relative to `dist/` (i.e. `workspace/code/proxy/.env`)
2. **Overridde** — set `PROXY_ENV_FILE` env var to point anywhere:

   ```bash
   PROXY_ENV_FILE="$HOME/hermes/.env-proxy" node dist/index.js
   ```

   If the file doesn't exist, the proxy exits immediately with an error.

3. **In `hermes/run.sh`** — `PROXY_ENV_FILE` is set to `$SCRIPT_DIR/.env-proxy` and passed through when starting the proxy daemon:

   ```bash
   PROXY_ENV_FILE="$PROXY_ENV_FILE" nohup node dist/index.js &
   ```

All env vars are documented in `.env.example`. Key groups:

- **Provider credentials**: `GONKA_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`, etc.
- **Model aliases** (root `/v1/models`): `MODEL{n}_ALIAS` + `MODEL{n}_TRY` chains
- **Rate limits**: `PROVIDER_TPM`, `PROVIDER_RPM`, `PROVIDER_RPH`, `PROVIDER_RPD`
- **Per-provider model filters**: `MODEL_ALLOW`, `GOOGLE_MODEL_ALLOW`, etc.
- **Model metadata** (context lengths, quirks): `src/providers/model-metadata.json`
- **System prompt injection**: `SYSTEM_PROMPT`, `SYSTEM_PROMPT_SUFFIX`

### Aliases — How They Work

Each alias has a **name** (what you ask for in `/v1/chat/completions`) and a **fallback chain** — an ordered list of `provider/model` entries. When a provider fails (rate limit, garbage, timeout, 5xx), the proxy silently tries the next entry.

**Resolution rules for `provider/model`:**
- Provider part (`gonka`, `deepseek`, `groq`, etc.) matches one of the 8 supported providers
- Model part is resolved **by suffix** — proxy matches it against the upstream catalog
- Examples:
  - `gonka/Kimi-K2.6` → matches upstream `moonshotai/Kimi-K2.6` (suffix match)
  - `gonka/MiniMaxAI/MiniMax-M2.7` → matches upstream `MiniMaxAI/MiniMax-M2.7` (exact)
  - `deepseek/deepseek-v4-flash` → matches upstream `deepseek/deepseek-v4-flash` (exact)
  - `groq/llama-4-maverick-17b-instruct` → matches upstream `groq/llama-4-maverick-17b-instruct` (exact)

All six forms are equivalent and will find the same model:
```
gonka/Kimi-K2.6                  # provider/model (short name)
gonka/moonshotai/Kimi-K2.6       # provider/model (full path)
Kimi-K2.6                        # model only (no provider)
models/Kimi-K2.6                 # model only (google-style prefix)
moonshotai/Kimi-K2.6             # upstream ID raw
anything/Kimi-K2.6               # any prefix, suffix match
```

### Alias Sources (merged, env wins)

1. **`.env` / `.env-proxy` (locked)** — `MODEL{n}_ALIAS` + `MODEL{n}_TRY`. Cannot be changed at runtime.
   ```bash
   MODEL1_ALIAS=gemma-4-12b
   MODEL1_TRY=local/google/gemma-4-12b-qat,gonka/Kimi-K2.6
   MODEL2_ALIAS=kimi
   MODEL2_TRY=gonka/Kimi-K2.6,gonka/MiniMaxAI/MiniMax-M2.7,deepseek/deepseek-v4-flash
   ```
   The `TRY` value is a comma-separated fallback chain — proxy runs left to right.

2. **`store/aliases.json` (user-managed)** — persisted, editable via `/v1/aliases` API.
   ```json
   {
     "version": 1,
     "aliases": {
       "kimi": [
         "gonka/Kimi-K2.6",
         "gonka/MiniMaxAI/MiniMax-M2.7",
         "deepseek/deepseek-v4-flash"
       ],
       "my-fast": [
         "groq/llama-4-maverick-17b-instruct",
         "cerebras/gpt-oss-120b"
       ]
     }
   }
   ```

**Alias API examples:**
```bash
# Create a new alias (persisted to store/aliases.json)
curl -s -X POST http://localhost:5001/v1/aliases \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "my-fast",
    "chain": ["groq/llama-4-maverick-17b-instruct", "cerebras/gpt-oss-120b"]
  }'

# List all aliases (shows locked status + chain)
curl -s http://localhost:5001/v1/aliases | jq .

# Update an existing alias
curl -s -X PUT http://localhost:5001/v1/aliases/my-fast \
  -H "Content-Type: application/json" \
  -d '{
    "chain": ["gonka/Kimi-K2.6", "deepseek/deepseek-v4-flash"]
  }'

# Delete a user alias (locked .env aliases cannot be deleted)
curl -s -X DELETE http://localhost:5001/v1/aliases/my-fast
```

**Chat with an alias (fallback chain runs automatically):**
```bash
# Request model "kimi" → proxy resolves alias → tries gonka/Kimi-K2.6 first
curl -s http://localhost:5001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kimi",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'

# If gonka fails → auto-retry with next in chain (gonka/MiniMaxAI/MiniMax-M2.7)
# If that also fails → deepseek/deepseek-v4-flash
# All exhausted → 502 error
```

## In Hermes

Smart routing via aliases:
```
/model <alias-name>
```

Direct per-provider routing:
```
/model --provider proxy-<provider> <model-id>
```

Available Hermes providers: `proxy`, `proxy-deepseek`, `proxy-openrouter`, `proxy-cerebras`, `proxy-groq`, `proxy-gonka`, `proxy-google`, `proxy-local`, `proxy-cursor`

## Performance

- `/v1/models` — ~2ms (in-memory catalog, no upstream calls)
- `/v1/chat/completions` — proxy overhead <1ms, streaming pass-through
- Catalog refreshed every 60s (15s when stale), background, non-blocking

## License

MIT