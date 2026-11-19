#!/usr/bin/env bash
# Real check: a headless `claude -p` loads this plugin with --plugin-dir (nothing installed, no settings files
# read, no MCP), starts one trivial and one hard subagent with model "sonnet" set on both, and prints which
# model and effort each subagent actually ran with, from the model-judge log and the session's transcripts.
# Costs a few cents (one short Opus answer). Claude Code writes the run's transcripts under ~/.claude/projects/
# as for any session; nothing else under ~/.claude is touched (the log goes to the temp folder).
# Same machinery as examples/demo.sh: test/headless-run.sh runs the session, test/run-report.mjs reads it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$(mktemp -d "${TMPDIR:-/tmp}/model-judge-run.XXXXXX")"
cat > "$RUN/prompt.md" <<'EOF'
Use the Agent tool exactly twice, one after the other (run_in_background: false), and set model: "sonnet" on both calls.
Call 1: description "trivial echo", subagent_type "general-purpose", prompt: "Reply with exactly the word pong. Do not use any tools."
Call 2: description "hard design", subagent_type "general-purpose", prompt: "Without using any tools, design a lock-free concurrent B+tree in Rust with MVCC snapshot isolation and WAL-based crash recovery, and sketch the TLA+ invariants that would prove linearizability. Keep the answer under 300 words."
Then report in one line each subagent's first 10 words.
EOF
"$ROOT/test/headless-run.sh" "$RUN/prompt.md" "$RUN"
node "$ROOT/test/run-report.mjs" "$RUN"
