#!/usr/bin/env bash
# Prove local chat goes through proxy scheduler (not direct LM Studio load).
set -euo pipefail
BASE="${GPU_PROXY_URL:-http://127.0.0.1:5001}"
BASE="${BASE%/}"
curl -sf -X POST "$BASE/v1/gpu/comfy/stop" -H 'content-type: application/json' -d '{"force":true}' >/dev/null || true
sleep 2

echo "=== scheduler before local chat ==="
curl -sf "$BASE/v1/scheduler" | jq -c '{running, queued: (.queued|length), residents: [.residents[].key]}'

RESP=$(curl -sf "$BASE/local/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"lmstudio-community/qwen2-vl-7b-instruct","messages":[{"role":"user","content":"Say ok"}],"max_tokens":5}' \
  2>/dev/null || echo '{}')
echo "=== local response ==="
echo "$RESP" | jq -c '{model, content: .choices[0].message.content, error: .error.message}'

echo "=== scheduler after ==="
curl -sf "$BASE/v1/scheduler" | jq -c '{running, residents: [.residents[].key]}'
