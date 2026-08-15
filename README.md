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

## Supported Providers (15)

| Provider | Chat URL | Supports |
|----------|---------|----------|
| **Gonka** | `/gonka/v1/` | Kimi-K2.6, MiniMax-M2.7, Qwen3-235B — garbage detection enabled |
| **Gonka-Dahl** | `/gonka-dahl/v1/` | Kimi-K2.6, MiniMax-M2.7 — Dahl inference proxy |
| **Gonka-API** | `/gonka-api/v1/` | Kimi-K2.6, MiniMax-M2.7 — Supabase edge |
| **JoinGonka** | `/joingonka/v1/` | Kimi-K2.6, MiniMax-M2.7 — gate.joingonka.ai |
| **Gonka-Mingles** | `/gonka-mingles/v1/` | Kimi-K2.6, MiniMax-M2.7 — router.mingles.ai |
| **Gonka-Router-IO** | `/gonka-router-io/v1/` | Kimi-K2.6, MiniMax-M2.7 — gonka router gateway |
| **Gonkabroker** | `/gonkabroker/v1/` | Kimi-K2.6, MiniMax-M2.7 — gonka broker gateway |
| **Hyperfusion** | `/hyperfusion/v1/` | MiniMax-M2.7 — LiteLLM proxy |
| **DeepSeek** | `/deepseek/v1/` | v4-flash (1M context), v4-pro, cache billing |
| **Google** | `/google/v1/` | Gemini 2.0/2.5/3.x flash+pro; `*-image*` generate/edit via native generateContent |
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
| `GET` | `/v1/router/queue` | Real-time queue + stats + throughput (JSON) |

### Queue API (`GET /v1/router/queue`)

Returns live snapshot of all queues, active requests, per-model statistics, and rolling throughput (1h / 24h) windows. Полный дашборд описан отдельно — см. `PROXY_DASHBOARD_UI.md` и `src/ui/proxy-dashboard-groq.py` (отдельный HTML-сервер на :8080).

```json
{
  "perModel": [{
    "key": "provider:model",
    "active": 1, "limit": 1,
    "waiters": [{"preview": "first 60 chars of request"}]
  }],
  "aliasGroups": [{
    "key": "kimi:g0", "alias": "kimi", "strategy": "random",
    "active": 5, "limit": 6,
    "members": [
      {"provider": "gonka", "model": "moonshotai/Kimi-K2.6", "active": 1, "limit": 1}
    ],
    "waiters": []
  }],
  "groupConfig": [{
    "provider": "gonka", "model": "moonshotai/Kimi-K2.6",
    "limit": 1, "group": 0, "strategy": "random"
  }],
  "stats": {
    "gonka:moonshotai/Kimi-K2.6": { "lastStatus": 200, "total": 15, "ok": 12, "fail": 3 }
  },
  "throughput": {
    "gonka:moonshotai/Kimi-K2.6": {
      "h1":  { "count": 5,   "durMs": 2500,  "bytes": 50000,  "tokensOut": 12000, "tps": 4800 },
      "h24": { "count": 120, "durMs": 60000, "bytes": 1200000, "tokensOut": 300000, "tps": 5000 }
    }
  },
  "incoming": [{
    "preview": "first 60 chars of request", "startedAt": 1786142339603
  }],
  "active": [{
    "key": "gonka:moonshotai/Kimi-K2.6", "provider": "gonka", "model": "moonshotai/Kimi-K2.6",
    "reqPreview": "first 40 chars of request", "reqSuffix": "last 40 chars",
    "startedAt": 1786142339603
  }],
  "recent": [{
    "key": "gonka:moonshotai/Kimi-K2.6", "provider": "gonka", "model": "moonshotai/Kimi-K2.6",
    "status": 200, "reqPreview": "first 40 chars...", "respPreview": "...last 40 chars",
    "startedAt": 1786142338000
  }]
}
```

- `perModel` — per-model concurrency queues (waiters in FIFO).
- `aliasGroups` — per-alias group pools: `strategy` = `random` (random free member), `order` (sequential), или `fastest` (самый быстрый свободный member по tokens/sec).
- `groupConfig` — статическая конфигурация групп алиаса (для дашборда).
- `stats` — cumulative since proxy start. `lastStatus` = последний HTTP-код; **`0` = garbage**; 429/413/5xx/garbage учитываются в `fail`.
- `throughput` — rolling-окна 1h/24h: `count`, суммарное время ответа `durMs`, отданные байты `bytes`, `tokensOut`, и `tps` (tokens/sec = tokens÷сек, либо bytes÷сек при отсутствии токенов). Записываются только успешные (2xx-3xx) ответы.
- `incoming` — client→proxy connections currently open. `startedAt` is unix ms.
- `active` — proxy→upstream requests in-flight, `reqPreview`/`reqSuffix` = first/last 40 chars.
- `recent` — last 20 completed requests (dashboard shows 10).
- Zombie connections старше 10 минут вычищается фоновым reaper.

### HTML Dashboard (`src/ui/proxy-dashboard-groq.py`)

Отдельный самодостаточный HTML-дашборд (Python `http.server` на `:8080`, автообновление 1s). Показывает: группы/алиасы целиком (даже с нулевыми счётчиками), модели со счётчиками success/fail и статусом (`000` = garbage), throughput 1h/24h (`tok/s`), живые/queued запросы, recent-лог. Запуск:

```bash
PROXY_ENV_FILE=~/.env-proxy python3 src/ui/proxy-dashboard-groq.py
# открой http://localhost:8080
# данные берёт из GET http://127.0.0.1:5001/v1/router/queue
```

### Per-Provider (`/{provider}/v1/`)

All 15 providers support `GET /{provider}/v1/models` and `POST /{provider}/v1/chat/completions` — no aliases, no fallback, direct pass-through.

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

Every failed attempt (429/413/5xx/402/network/garbage) is recorded in per-model `stats`: `fail++` and `lastStatus`. **Garbage is stored as `lastStatus: 0`** (отображается как `000 · garbage` в дашборде) — а не как фейковый `200`.

## Image generation / editing

Hermes and other OpenAI clients keep using **`POST /v1/chat/completions`** (or `/{provider}/v1/chat/completions`). There is no separate `/images` or admin endpoint.

The proxy normalizes every image-out model to the same OpenAI shape:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "optional caption" },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
      ]
    }
  }]
}
```

**How to call it**

- Model: a Gemini image id (`gemini-3-pro-image`, `gemini-2.5-flash-image`, `gemini-3.1-flash-image`, …) via Google, or the OpenRouter id (`google/gemini-3-pro-image-preview`) via OpenRouter.
- Input photo (edit): put a data-URI (or https URL) in the user message as an `image_url` part, plus a text instruction.
- Do **not** send `reasoning_effort` / thinking / tools — the proxy strips them for `*-image*` models (those Gemini variants reject thinking).
- `stream: true` is forced to a single JSON completion (JPEG does not stream usefully).

```bash
# Generate or edit via Google (native generateContent under the hood)
curl -s http://localhost:5001/google/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash-image",
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "Make the sky more dramatic" },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
      ]
    }]
  }' | jq -r '.choices[0].message.content[] | select(.type=="image_url") | .image_url.url' \
  | sed 's/^data:image\/[^;]*;base64,//' | base64 -d > out.jpg
```

Root `/v1/chat/completions` works the same if the requested model resolves to a Google/OpenRouter image id (alias or raw).

**What the proxy does internally (for the next agent)**

| Layer | Behavior |
|-------|----------|
| Capabilities | `*-image*` models advertise `output_modalities: ["text","image"]` (vision-in is not the same as image-out). |
| `adaptForModel` | Strips thinking/tools; OpenRouter gets `modalities: ["image","text"]`. |
| `ProviderAdapter.prepareChat` | Default OpenAI-compat adapters stay on `/chat/completions`. **Google image models** switch to native `models/{id}:generateContent` with `responseModalities: ["TEXT","IMAGE"]` — Google's OpenAI-compat layer returns `Unhandled generated data mime type: image/jpeg` otherwise. |
| `normalizeChatResponse` | Gemini `inlineData` and OpenRouter `message.images` become `content[].image_url` data URIs. |

New image-out providers should implement those two adapter hooks instead of adding a Google-only branch in `forward.ts`. Shared helpers live in `src/image-output.ts`.

### Gonka-family & MiniMax message handling

- **Request normalization**: провайдеры gonka-family требуют `messages[].content` как массив блоков `[{type:"text",text:"…"}]`. Прокси автоматически нормализует строковый `content` в массив блоков и убирает пустой `content` у assistant-сообщений с `tool_calls` (для всех gonka-провайдеров; остальные провайдеры не затрагиваются).
- **MiniMax agentic tool calls**: MiniMax S2 иногда возвращает вызов инструмента как XML в `content` (`<minimax:tool_call><invoke name="…"><parameter name="…">…</parameter></invoke></minimax:tool_call>`) вместо стандартного `tool_calls`. Для **sync**-ответов прокси конвертирует такой XML в стандартный `tool_calls` (вырезает XML из `content`, ставит `finish_reason:"tool_calls"`). Streaming-конвертация — в планах.

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
- Provider part (`gonka`, `deepseek`, `groq`, etc.) matches one of the 15 supported providers
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

2. **`store/aliases.json` (user-managed, v2)** — persisted, editable via `/v1/aliases` API. Each alias has named **groups**, каждый с `strategy` и списком `members`:
   ```json
   {
     "version": 2,
     "aliases": {
       "kimi": {
         "groups": [
           { "strategy": "random",
             "members": [
               "gonka-dahl/moonshotai/Kimi-K2.6",
               "gonka-api/moonshotai/Kimi-K2.6",
               "gonka/moonshotai/Kimi-K2.6",
               "gonkabroker/MiniMaxAI/MiniMax-M2.7"
             ] },
           { "strategy": "order",
             "members": [
               "hyperfusion/MiniMaxAI/MiniMax-M2.7",
               "deepseek/deepseek-v4-flash"
             ] }
         ]
       }
     }
   }
   ```
   `strategy` per group: `random` | `order` | `fastest`.
   - `random` — случайный свободный member.
   - `order` — первый свободный member.
   - `fastest` — свободный member с максимальным `tps` (1h window, fallback 24h; неизмеренные — последними, ties random). Питается из `throughput` в `/v1/router/queue`.

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

Image generate/edit (same chat API; save the returned `data:` URL to a file):

```
/model --provider proxy-google gemini-2.5-flash-image
```

Then send a user message with the photo as `image_url` (data URI) plus the edit prompt. The assistant `content` array includes `{type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}}`. Write that payload to disk — do not expect a remote http URL. See **Image generation / editing** above.

## Performance

- `/v1/models` — ~2ms (in-memory catalog, no upstream calls)
- `/v1/chat/completions` — proxy overhead <1ms, streaming pass-through
- Catalog refreshed every 60s (15s when stale), background, non-blocking

## License

MIT