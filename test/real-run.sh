#!/usr/bin/env bash
# Real check: a headless `claude -p` loads this plugin with --plugin-dir (nothing installed, no settings files
# read, no MCP), starts one trivial and one hard subagent with model "sonnet" set on both, and prints which
# model and effort each subagent actually ran with, from the judge-router log and the session's transcripts.
# Costs a few cents (one short Opus answer). Claude Code writes the run's transcripts under ~/.claude/projects/
# as for any session; nothing else under ~/.claude is touched (the log goes to the temp folder).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$(mktemp -d "${TMPDIR:-/tmp}/judge-router-run.XXXXXX")"
mkdir -p "$RUN/work" "$RUN/log"
cd "$RUN/work"

PROMPT='Use the Agent tool exactly twice, one after the other (run_in_background: false), and set model: "sonnet" on both calls.
Call 1: description "trivial echo", subagent_type "general-purpose", prompt: "Reply with exactly the word pong. Do not use any tools."
Call 2: description "hard design", subagent_type "general-purpose", prompt: "Without using any tools, design a lock-free concurrent B+tree in Rust with MVCC snapshot isolation and WAL-based crash recovery, and sketch the TLA+ invariants that would prove linearizability. Keep the answer under 300 words."
Then report in one line each subagent'"'"'s first 10 words.'

JUDGE_ROUTER_DIR="$RUN/log" claude -p --plugin-dir "$ROOT" --setting-sources "" --strict-mcp-config \
  --model sonnet --output-format stream-json --verbose "$PROMPT" > "$RUN/stream.jsonl"

echo "== what the main agent asked for (its Agent tool calls)"
jq -c 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use") | {description: .input.description, model: .input.model, effort: .input.effort}' "$RUN/stream.jsonl"

echo "== judge-router decisions ($RUN/log/decisions.jsonl)"
jq -c '{description, difficulty, confidence, judge_ms, model: "\(.model_before) -> \(.model_after)", effort: "\(.effort_before) -> \(.effort_after)", why}' "$RUN/log/decisions.jsonl"

SESSION="$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id' "$RUN/stream.jsonl")"
TRANSCRIPT="$(find "$HOME/.claude/projects" -maxdepth 2 -name "$SESSION.jsonl" | head -1)"
SUB="${TRANSCRIPT%.jsonl}/subagents"
echo "== session $SESSION: each subagent's metadata and the model on its API responses ($SUB)"
for meta in "$SUB"/*.meta.json; do
  t="${meta%.meta.json}.jsonl"
  jq -c --arg ran "$(jq -r 'select(.type=="assistant") | .message.model' "$t" | sort -u | paste -sd, -)" \
    '{description, requested_model: .model, requested_effort: .effort, ran_on: $ran}' "$meta"
done

echo "== models billed in the session (result.modelUsage)"
jq -c 'select(.type=="result") | .modelUsage | with_entries(.value |= {outputTokens, costUSD})' "$RUN/stream.jsonl"
echo "(run folder: $RUN)"
