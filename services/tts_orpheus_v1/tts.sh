#!/usr/bin/env bash
# Orpheus TTS engine entrypoint (host). Called by proxy tts_orpheus_v1/run.py.
# Keeps ALL tunable host paths in ONE place (the setting engine_root); this
# script locates its own siblings relative to itself so it works wherever it
# is placed under engine_root. Model auto-download + venv are handled by
# engine.py (best-effort).
set -uo pipefail

# --- resolve own dir (engine_root) ---------------------------------------
ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TEXT=""
VOICE="tara"
OUT_DIR=""
FORMAT="ogg"
TEMP=""
TOP_P=""
REP=""

usage() {
  echo "usage: tts.sh --text STR [--voice NAME] [--out_dir DIR] [--format ogg|mp3|wav] [--temperature F] [--top_p F] [--repetition_penalty F]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --text) TEXT="$2"; shift 2;;
    --voice) VOICE="$2"; shift 2;;
    --out_dir) OUT_DIR="$2"; shift 2;;
    --format) FORMAT="$2"; shift 2;;
    --temperature) TEMP="$2"; shift 2;;
    --top_p) TOP_P="$2"; shift 2;;
    --repetition_penalty) REP="$2"; shift 2;;
    *) usage;;
  esac
done

if [[ -z "$TEXT" || -z "$OUT_DIR" ]]; then
  usage
fi
mkdir -p "$OUT_DIR"

args=(--text "$TEXT" --voice "$VOICE" --out_dir "$OUT_DIR" --format "$FORMAT")
[[ -n "$TEMP" ]] && args+=(--temperature "$TEMP")
[[ -n "$TOP_P" ]] && args+=(--top_p "$TOP_P")
[[ -n "$REP" ]] && args+=(--repetition_penalty "$REP")

PY=""
if [[ -x "$ENGINE_DIR/.venv/bin/python" ]]; then
  PY="$ENGINE_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="$(command -v python3)"
else
  echo "no python3 found on host" >&2
  exit 1
fi

exec "$PY" "$ENGINE_DIR/engine.py" "${args[@]}"
