#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://localhost:5001}"
PASS=0
FAIL=0

green() { echo -e "\033[32m  PASS\033[0m $1"; ((PASS++)) || true; }
red()   { echo -e "\033[31m  FAIL\033[0m $1 — $2"; ((FAIL++)) || true; }
assert() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then green "$label"; else red "$label" "expected '$expected' got '$actual'"; fi
}
assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then green "$label"; else red "$label" "missing '$needle'"; fi
}
assert_gt() {
  local label="$1" threshold="$2" actual="$3"
  if [[ "$actual" -gt "$threshold" ]]; then green "$label"; else red "$label" "expected > $threshold got $actual"; fi
}

echo "=============================================="
echo " LLM Proxy Integration Tests"
echo " base: $BASE"
echo "=============================================="

# ─── 1. Health ───
echo ""; echo "─── Health ───"
HEALTH=$(curl -sf "$BASE/health" | jq -r '.status')
assert "health check" "ok" "$HEALTH"

# ─── 2. Root /v1/models (aliases only) ───
echo ""; echo "─── Root /v1/models ───"
MODELS=$(curl -sf "$BASE/v1/models" | jq -c '[.data[].id]')
MODEL_COUNT=$(echo "$MODELS" | jq 'length')
assert_gt "model count > 5" 5 "$MODEL_COUNT"
assert_contains "contains kimi" '"kimi"' "$MODELS"
assert_contains "contains gemma-4-12b" '"gemma-4-12b"' "$MODELS"
assert_contains "contains deepseek-v4-flash" '"deepseek-v4-flash"' "$MODELS"
# MUST NOT contain raw upstream IDs
if echo "$MODELS" | grep -qF '"Kimi-K2.6"' || echo "$MODELS" | grep -qF '"MiniMax-M2.7"'; then
  red "no raw upstream IDs" "found Kimi-K2.6 or MiniMax-M2.7 in aliases"
else
  green "no raw upstream IDs in root models"
fi

# ─── 3. /v1/models/kimi detail ───
echo ""; echo "─── /v1/models/kimi ───"
KIMI_DETAIL=$(curl -sf "$BASE/v1/models/kimi")
KIMI_UPSTREAM=$(echo "$KIMI_DETAIL" | jq -r '.upstream_id')
assert "kimi upstream_id is full name" "moonshotai/Kimi-K2.6" "$KIMI_UPSTREAM"
KIMI_PROVIDER=$(echo "$KIMI_DETAIL" | jq -r '.provider')
assert "kimi provider is gonka" "gonka" "$KIMI_PROVIDER"

# ─── 4. /v1/aliases ───
echo ""; echo "─── /v1/aliases ───"
ALIASES=$(curl -sf "$BASE/v1/aliases" | jq -c '[.data[].alias]')
assert_contains "aliases contains kimi" '"kimi"' "$ALIASES"
assert_contains "aliases contains gemma-4-12b" '"gemma-4-12b"' "$ALIASES"
# kimi must be unlocked
KIMI_LOCKED=$(curl -sf "$BASE/v1/aliases/kimi" | jq '.locked')
assert "kimi alias is unlocked" "false" "$KIMI_LOCKED"
KIMI_CHAIN=$(curl -sf "$BASE/v1/aliases/kimi" | jq -c '.chain')
assert "kimi chain has 3 entries" '["gonka/Kimi-K2.6","gonka/MiniMaxAI/MiniMax-M2.7","deepseek/deepseek-v4-flash"]' "$KIMI_CHAIN"

# ─── 5. Root chat with alias ───
echo ""; echo "─── POST /v1/chat/completions (kimi alias) ───"
CHAT=$(curl -sf "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":20}')
CHAT_MODEL=$(echo "$CHAT" | jq -r '.model')
CHAT_CONTENT=$(echo "$CHAT" | jq -r '.choices[0].message.content')
assert "kimi chat model" "moonshotai/Kimi-K2.6" "$CHAT_MODEL"
assert_gt "kimi response non-empty" 0 "$(echo "$CHAT_CONTENT" | wc -c)"
echo "       content: $(echo "$CHAT_CONTENT" | head -c 80)"

# ─── 6. Root chat with another alias ───
echo ""; echo "─── POST /v1/chat/completions (deepseek-v4-flash alias) ───"
DS_CHAT=$(curl -sf "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":10}')
DS_MODEL=$(echo "$DS_CHAT" | jq -r '.model')
assert "deepseek chat model contains deepseek" "true" "$(echo "$DS_MODEL" | grep -qi deepseek && echo true || echo false)"
assert_gt "deepseek response non-empty" 0 "$(echo "$DS_CHAT" | jq -r '.choices[0].message.content' | wc -c)"

# ─── 7. Per-provider /gonka/v1/models ───
echo ""; echo "─── GET /gonka/v1/models (raw upstream) ───"
GONKA_MODELS=$(curl -sf "$BASE/gonka/v1/models" | jq -c '[.data[].id]')
assert_contains "gonka has moonshotai/Kimi-K2.6" '"moonshotai/Kimi-K2.6"' "$GONKA_MODELS"
assert_contains "gonka has MiniMaxAI/MiniMax-M2.7" '"MiniMaxAI/MiniMax-M2.7"' "$GONKA_MODELS"
# Per-provider must have raw IDs, not aliases
GONKA_HAS_KIMI_ALIAS=$(echo "$GONKA_MODELS" | grep -cF '"kimi"' || true)
assert "gonka models does NOT contain kimi alias" "0" "$GONKA_HAS_KIMI_ALIAS"

# ─── 8. Per-provider direct chat ───
echo ""; echo "─── POST /gonka/v1/chat/completions (direct) ───"
DIRECT_CHAT=$(curl -sf "$BASE/gonka/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"moonshotai/Kimi-K2.6","messages":[{"role":"user","content":"hi"}],"max_tokens":10}')
DIRECT_MODEL=$(echo "$DIRECT_CHAT" | jq -r '.model')
assert "direct gonka chat model" "moonshotai/Kimi-K2.6" "$DIRECT_MODEL"
assert_gt "direct gonka response non-empty" 0 "$(echo "$DIRECT_CHAT" | jq -r '.choices[0].message.content' | wc -c)"

# ─── 9. Per-provider deepseek direct ───
echo ""; echo "─── POST /deepseek/v1/chat/completions (direct) ───"
DS_DIRECT_CHAT=$(curl -sf "$BASE/deepseek/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Say hi"}],"max_tokens":10}')
DS_DIRECT_MODEL=$(echo "$DS_DIRECT_CHAT" | jq -r '.model')
# deepseek may return various model id forms
assert_contains "direct deepseek model contains flash" "flash" "$DS_DIRECT_MODEL"
assert_gt "direct deepseek response non-empty" 0 "$(echo "$DS_DIRECT_CHAT" | jq -r '.choices[0].message.content' | wc -c)"

# ─── 10. Fallback chain test ───
echo ""; echo "─── Fallback chain behavior ───"
# gemma-4-12b alias: local/google/gemma-4-12b-qat → gonka/Kimi-K2.6
# If local LM Studio is down, should fallback to gonka
G_FALLBACK=$(curl -sf "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma-4-12b","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' || true)
if echo "$G_FALLBACK" | jq -e '.choices[0].message.content' >/dev/null 2>&1; then
  green "gemma-4-12b fallback got response"
  GF_MODEL=$(echo "$G_FALLBACK" | jq -r '.model // "unknown"')
  echo "       resolved model: $GF_MODEL"
else
  GF_ERR=$(echo "$G_FALLBACK" | jq -r '.error.message // "no response"' 2>/dev/null || echo "no response")
  red "gemma-4-12b fallback" "$GF_ERR"
fi

# ─── 11. Invalid model → 400 ───
echo ""; echo "─── Error handling ───"
BAD_MODEL=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"nonexistent-model-xyz","messages":[{"role":"user","content":"hi"}]}')
assert "unknown model returns 400" "400" "$BAD_MODEL"

# ─── 12. Unknown provider endpoint → 400 ───
BAD_PROVIDER=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/nonexistent/v1/models")
assert "unknown provider returns 400" "400" "$BAD_PROVIDER"

# ─── 13. Admin endpoints ───
echo ""; echo "─── Admin endpoints ───"
ROUTER_STATUS=$(curl -sf "$BASE/v1/router/status")
ROUTER_COUNT=$(echo "$ROUTER_STATUS" | jq '.provider_states | length')
assert_gt "router status has provider_states" 0 "$ROUTER_COUNT"
ROUTER_LIVE=$(echo "$ROUTER_STATUS" | jq '[.provider_states[] | select(.state == "live")] | length')
assert_gt "at least 1 live provider" 0 "$ROUTER_LIVE"

ROUTER_PROVIDERS=$(curl -sf "$BASE/v1/router/providers")
PROVIDER_KEYS=$(echo "$ROUTER_PROVIDERS" | jq 'keys | length')
assert_gt "router providers has entries" 0 "$PROVIDER_KEYS"

# ─── 14. Streaming (SSE) ───
echo ""; echo "─── Streaming (SSE) ───"
SSE_OUT=$(curl -sf "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi","messages":[{"role":"user","content":"Say hi"}],"max_tokens":10,"stream":true}' 2>&1 || echo "")
if echo "$SSE_OUT" | grep -q 'data:'; then
  green "streaming SSE response received"
else
  red "streaming SSE" "no data: lines found"
fi

# ─── Summary ───
echo ""
echo "=============================================="
echo " RESULTS: $PASS passed, $FAIL failed"
echo "=============================================="
if [[ "$FAIL" -gt 0 ]]; then exit 1; fi