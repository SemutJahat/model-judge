#!/usr/bin/env bash
# Run one headless Claude Code session with this plugin loaded from the repo, and nothing else:
#   test/headless-run.sh PROMPT_FILE RUN_DIR
# --plugin-dir loads the plugin for this run only (nothing installed); --setting-sources "" reads no settings
# files (so no other plugins or hooks of yours); --strict-mcp-config starts no MCP servers. The session works in
# RUN_DIR/work, writes its stream to RUN_DIR/stream.jsonl and the model-judge log to RUN_DIR/log/decisions.jsonl.
# Claude Code still saves the session's transcript under ~/.claude/projects/, as for any session.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="$1"
RUN="$2"
mkdir -p "$RUN/work" "$RUN/log"
cd "$RUN/work"
# PERMISSION_MODE (default, acceptEdits, auto, bypassPermissions) runs it in that mode; unset, Claude Code's default.
MODEL_JUDGE_DIR="$RUN/log" claude -p --plugin-dir "$ROOT" --setting-sources "" --strict-mcp-config \
  ${PERMISSION_MODE:+--permission-mode "$PERMISSION_MODE"} \
  --model "${MAIN_MODEL:-sonnet}" --output-format stream-json --verbose "$(cat "$PROMPT_FILE")" \
  < /dev/null > "$RUN/stream.jsonl" 2> "$RUN/stderr.txt"
