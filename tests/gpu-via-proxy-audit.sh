#!/usr/bin/env bash
# Static checks that Hermes/videogen/motion use proxy queue paths (not legacy gpu_prep bridge).
set -euo pipefail

ROOT="${HERMES_ROOT:-$HOME/hermes}"
FAIL=0

check_absent() {
  local label="$1" pattern="$2" path="$3"
  if rg -q "$pattern" "$path" 2>/dev/null; then
    echo "FAIL: $label still matches in $path"
    rg -n "$pattern" "$path" | head -5
    FAIL=1
  else
    echo "OK: $label"
  fi
}

check_present() {
  local label="$1" pattern="$2" path="$3"
  if rg -q "$pattern" "$path" 2>/dev/null; then
    echo "OK: $label"
  else
    echo "FAIL: expected $label in $path"
    FAIL=1
  fi
}

echo "=== Hermes tools ==="
check_absent "zgen imports gpu_prep" 'from gpu_prep|import gpu_prep' "$ROOT/workspace/tools/zgen"
check_present "zgen uses image_t2i" 'image_t2i_zturbo_v1' "$ROOT/workspace/tools/zgen"
check_present "vision uses proxy_chat" 'proxy_chat' "$ROOT/workspace/tools/vision_qwen2vl.py"
check_absent "vision imports gpu_prep" 'from gpu_prep|ensure_model_ready' "$ROOT/workspace/tools/vision_qwen2vl.py"

echo "=== Videogen ==="
for s in face_refine.sh bg_replace.sh scene_cinematic.sh i2v.sh t2v.sh r2v.sh; do
  check_present "videogen dispatch $s" 'videogen_entry_dispatch|videogen_proxy_' "$ROOT/workspace/code/videogen/$s"
done
check_present "lib_common proxy default" 'VIDEOGEN_USE_PROXY_QUEUE' "$ROOT/workspace/code/videogen/lib_common.sh"

echo "=== Motion server ==="
check_present "motion proxyGpuQueue" 'submitProxyServiceJob|useProxyGpuQueue' \
  "$ROOT/workspace/topics/video-motion-pipeline/server/src/proxyGpuQueue.js"
check_present "jobs uses proxy" 'useProxyGpuQueue' \
  "$ROOT/workspace/topics/video-motion-pipeline/server/src/jobs.js"

echo "=== Config ==="
check_present "config local-services MCP" 'host.docker.internal:5001/mcp' "$ROOT/data/config.yaml"
check_absent "config comfy-z-turbo 8005" '8005/mcp|comfy-z-turbo' "$ROOT/data/config.yaml"

if (( FAIL != 0 )); then
  echo ""
  echo "Audit failed."
  exit 1
fi
echo ""
echo "Audit passed."
