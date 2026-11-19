# judge-router

A Claude Code plugin. Just before Claude Code starts a subagent, a small judge model rates the subagent's
prompt **easy / medium / hard**. The plugin then sets the subagent's **model** and **effort** to match,
replacing whatever the caller or the subagent's definition had set.

It needs nothing besides Claude Code and Node: the judge runs on your own Claude Code login
(`claude -p --model haiku`). When `ANTHROPIC_API_KEY` is set, it calls the Messages API directly, which is faster.

## What it does

- A `PreToolUse` hook on the subagent tool (matcher `Agent|Task`). In Claude Code 2.1.328 the tool is
  named `Agent`; `Task` is its legacy alias.
- The hook reads the tool input from stdin. It sends the `prompt`, `description` and `subagent_type` to the judge,
  which answers `{"difficulty", "confidence", "why"}`.
- It answers Claude Code with `hookSpecificOutput.updatedInput`: the original input, with `model` and `effort`
  set from the route of that difficulty.
- It sets no `permissionDecision`. The call still goes through Claude Code's normal permission check, and the
  hook neither approves nor denies anything.
- It shows you one line per subagent call (its verdict and the model and effort it set), adds a
  `/judge-router:log` command, and ships an optional status line. See
  [Seeing what the judge does](#seeing-what-the-judge-does).

Default routes (in `config.json`):

| difficulty | model    | effort   |
|------------|----------|----------|
| easy       | `haiku`  | `low`    |
| medium     | `sonnet` | `medium` |
| hard       | `opus`   | `high`   |

### The override rule

When the judge answers with confidence ≥ the threshold (default **0.75**), its model **always replaces** the
`model` in the call, whether the main agent set one, the agent definition's frontmatter set one, or nobody did.
It does this even when the model is the same. The Agent tool's `model` field takes precedence over the
definition's `model:` frontmatter and over `CLAUDE_CODE_SUBAGENT_MODEL`, so setting it on the call is enough.
The judge's effort replaces `effort` the same way.

The input is left **unchanged** (and the hook exits 0) when:

- the judge is unsure (confidence < threshold);
- the judge fails: `claude` not found, it exits non-zero, or its answer isn't the expected JSON;
- the judge takes longer than `timeoutMs` (default **15 s**); the judge is killed;
- the subagent is a `fork`, since Claude Code ignores model and effort for forks;
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, since Claude Code then removes `model` from the tool;
- the hook runs inside the judge itself (`JUDGE_ROUTER_INNER=1`, the recursion guard).

It never blocks a subagent: every path exits 0, and any error only leaves the call as it was.

## Effort: it can be set per call

Claude Code 2.1.328's Agent tool has an `effort` field: `low | medium | high | xhigh | max`. It is a zod enum in
the tool's schema, next to `model: sonnet | opus | haiku | fable`. A hook's `updatedInput` can set it, so
judge-router sets the judge's effort on every call it routes. The real run below shows the subagents ran with
the effort the hook set: each subagent's `meta.json` in the session transcript records it.

Limits found in Claude Code:

- **`CLAUDE_CODE_EFFORT_LEVEL` pins effort.** When it is set (to anything but `auto`/`unset`), Claude Code removes
  `effort` from the Agent tool. A hook input that fails the schema check makes Claude Code deny the call, so
  in that case judge-router sets only the model and leaves effort alone (the log notes it).
- `CLAUDE_CODE_SUBAGENT_EFFORT` is only the default when a call sets no effort, so the hook's effort wins over it.
- For `subagent_type: "fork"`, Claude Code ignores both fields, and the hook doesn't touch forks.
- The plugin can't show that the effort reaches the API request itself. Claude Code doesn't log the effort
  parameter of a request. What the transcript shows is the effort the subagent was started with.

## Latency

Each routed subagent waits for one judge call before it starts. Measured on this Mac (macOS, Claude Code
2.1.328, judge `claude -p --model haiku` → Claude Haiku 5.5, no API key), over 12 real calls:
**2.7 s to 4.2 s, median ≈ 3.2 s**, about $0.0002 per call. A bare `claude -p` judge call timed with `time`:
3.07 s wall, of which the model took 2.0 s (`duration_ms`). The API path skips the CLI's start-up and should be
faster, but no API key was available here to time it.

## Seeing what the judge does

Three views. All of them run without enowX, and none touches the decision or the permission check.

### 1. A line under each subagent call (on by default)

The hook adds a `systemMessage` to its answer. Claude Code 2.1.328 shows a PreToolUse hook's `systemMessage`
to the user right under the tool call, as `PreToolUse:Agent says: …`. This was captured from a real interactive
session (`claude --plugin-dir … --permission-mode default`, run in a pseudo-terminal), where one prompt
started four subagents, all requesting `sonnet`:

```
⏺ 4 background agents launched (↓ to manage)
   ├ Agent (count words)
   ├ Agent (slugify with tests)
   ├ Agent (rate limiter design)
   └ Explore (vague task)
  ⎿  PreToolUse:Agent says: ⚖ judge-router: "count words" → easy 0.97 · sonnet→haiku · effort low (3.4s)
  ⎿  PreToolUse:Agent says: ⚖ judge-router: "slugify with tests" → medium 0.85 · sonnet→sonnet · effort medium (2.7s)
  ⎿  PreToolUse:Agent says: ⚖ judge-router: "rate limiter design" → hard 0.85 · sonnet→opus · effort high (4.3s)
  ⎿  PreToolUse:Agent says: ⚖ judge-router: "vague task" unsure 0.40 (easy?) → left as sonnet (3.5s)
```

The subagents' transcripts confirm it: `count words` ran on `claude-haiku-5-5` (effort low), `slugify with tests`
on `claude-sonnet-5-5` (medium), `rate limiter design` on `claude-opus-5-5` (high), and `vague task` stayed on
`claude-sonnet-5-5` with no effort set.

The other forms of the line:

```
⚖ judge-router: "x" judge failed (cli: claude -p timed out after 15000 ms) → left as sonnet (15.0s)
⚖ judge-router: "x" skipped (fork) → left as default
```

`"display"` in `config.json` sets how much it says:
- `"all"` (default): every decision.
- `"changes"`: only when the model or effort changed, or the judge failed.
- `"off"`: nothing; the log still records everything.

When the input is left unchanged, the hook prints only `{"systemMessage": …}`, with no `hookSpecificOutput`.

### 2. `/judge-router:log [N]`, and the same in a terminal

The plugin adds a slash command, `/judge-router:log`. It runs `scripts/log.mjs` and shows the last N decisions,
10 by default. It runs `node` only, which its `allowed-tools` frontmatter permits, so it asks for no permission.
Captured from the interactive session:

```
❯ /judge-router:log
⏺ time      subagent                      verdict  conf  model              effort         judge   result
  ────────  ────────────────────────────  ───────  ────  ─────────────────  ─────────────  ──────  ─────────
  22:44:07  count words                   easy     0.97  sonnet→haiku       -→low          3.4s    override
  22:44:08  slugify with tests            medium   0.85  sonnet→sonnet      -→medium       2.7s    override
  22:44:09  vague task                    easy     0.40  sonnet→sonnet      -              3.5s    unsure
  22:44:09  rate limiter design           hard     0.85  sonnet→opus        -→high         4.3s    override
  (4 of 4, from …/decisions.jsonl)
```

(The test session logged to a temp folder, so its path is shortened here.)

The command's output reaches the model, which then repeats it to you. That costs one short model turn.
In a terminal, with no model involved:

```sh
node ~/Script/claude-judge-router/scripts/log.mjs            # last 10 (or: log.mjs 25, -n 25)
node ~/Script/claude-judge-router/scripts/log.mjs --watch    # then follow new decisions live, in another terminal
node ~/Script/claude-judge-router/scripts/log.mjs --session SESSION_ID --json
```

### 3. Status line (opt-in)

`scripts/statusline.mjs` shows the current session's latest decision under the prompt. It prints nothing until
the session's first subagent. Captured at the bottom of the interactive session above:

```
❯
───────────────────────────────────────────
  ⚖ opus/high · hard 0.85 · "rate limiter design"
```

The other forms: `⚖ sonnet (unsure 0.40) · "vague task"`, `⚖ default (judge failed)`. Nothing sets this up
for you. To opt in, add this line to your `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node ~/Script/claude-judge-router/scripts/statusline.mjs" }
```

To try it for one session without editing any settings file:
`claude --plugin-dir ~/Script/claude-judge-router --settings '{"statusLine":{"type":"command","command":"node ~/Script/claude-judge-router/scripts/statusline.mjs"}}'`.
If you already have a status line, call both from one command, and pass the same stdin to each:
`sh -c 'i=$(cat); printf %s "$i" | your-statusline; printf " "; printf %s "$i" | node …/statusline.mjs'`.

## Try it yourself

None of these install anything. They use the plugin straight from this folder.

**1. One-command demo** (about 30–60 s, a few cents):

```sh
./examples/demo.sh                              # examples/prompts/mixed.md: easy + medium + hard, all requesting sonnet
./examples/demo.sh examples/prompts/ambiguous.md   # or any other prompt file
```

It runs a headless session in a throwaway temp folder and prints one row per subagent: the model requested, the
judge's verdict, what the hook set, and what the subagent started with and ran on. The real run is shown under
[Real run](#real-run-evidence).

**2. Prompts to paste into an interactive session.** Start Claude Code with the plugin loaded for that session:

```sh
claude --plugin-dir ~/Script/claude-judge-router
```

Then paste a file from `examples/prompts/`. Each one asks for subagents with `model: "sonnet"` and gives each
subagent's prompt in a ```` ```task ```` block:

| file | what to expect |
|---|---|
| `easy.md` | count words: easy → **haiku**, effort low |
| `medium.md` | slugify function with edge cases and tests: medium → **sonnet**, effort medium |
| `hard.md` | distributed rate limiter design: hard → **opus**, effort high |
| `mixed.md` | all three in one go |
| `ambiguous.md` | "Look into it and do what's needed.": the judge is unsure (confidence ≈ 0.3–0.45 < 0.75), so the call is **left unchanged** (sonnet, no effort) |

**3. Just the judge, no subagent** (about 3 s per prompt):

```sh
node examples/dry-run.mjs "Count the words in: the quick brown fox"
echo "Design a sharded job queue with exactly-once delivery" | node examples/dry-run.mjs --model sonnet
node examples/dry-run.mjs --model sonnet --file examples/prompts/mixed.md   # judges each task block
node examples/dry-run.mjs --json --file examples/prompts/hard.md            # the log line it would write
```

It runs the same `decide()` as the hook, with the same config, judge and threshold. It prints the verdict and the
model and effort it would set, and writes nothing to the log unless you pass `--log`.

**Watching while you try.** In an interactive session, each subagent call shows its judge-router line (see
[Seeing what the judge does](#seeing-what-the-judge-does)). Type `/judge-router:log` for the table, or keep
`node scripts/log.mjs --watch` running in a second terminal.

**Reading the log.** Every subagent the hook sees in a normal session adds a line to
`~/.claude/judge-router/decisions.jsonl` (the demo writes to its temp folder instead). Use `node scripts/log.mjs`
for a table, or `jq` for the raw lines:

```sh
jq -c '{ts, description, difficulty, confidence, model: "\(.model_before) -> \(.model_after)", effort_after, action, reason}' ~/.claude/judge-router/decisions.jsonl | tail
```

**Seeing the real model in a subagent's transcript.** Claude Code keeps each subagent's transcript next to the
session's, in `~/.claude/projects/<project folder>/<session id>/subagents/`:

```sh
S=$(echo ~/.claude/projects/*/SESSION_ID/subagents)   # SESSION_ID: from the log line's session_id
cat $S/agent-*.meta.json                    # {"description":…, "model":"haiku", "effort":"low", "toolUseId":…}
jq -r 'select(.type=="assistant") | .message.model' $S/agent-*.jsonl | sort | uniq -c   # e.g. claude-haiku-5-5
```

`toolUseId` in `meta.json` is the `tool_use_id` of the log line, so the two can be matched.

## Install / uninstall

Nothing is installed by this repository. To install it for your user, from a terminal:

```sh
claude plugin marketplace add ~/Script/claude-judge-router   # adds the local marketplace "judge-router-local"
claude plugin install judge-router@judge-router-local
```

Restart Claude Code (or open a new session) for the hook to load. To remove it:

```sh
claude plugin uninstall judge-router@judge-router-local
claude plugin marketplace remove judge-router-local
```

To try it for one session without installing anything:

```sh
claude --plugin-dir ~/Script/claude-judge-router
```

Installing copies the plugin into Claude Code's plugin cache. After you edit files here, run
`claude plugin marketplace update judge-router-local` and reinstall, or keep your changes in the user config
file below.

## Config

`config.json` in the plugin:

```json
{
  "judgeModel": "haiku",                 // model for `claude -p --model …`
  "judgeApiModel": "claude-haiku-5-5",   // model id when ANTHROPIC_API_KEY is used
  "useApiKey": true,                     // use ANTHROPIC_API_KEY when it is set, falling back to claude -p
  "confidenceThreshold": 0.75,
  "timeoutMs": 15000,
  "maxPromptChars": 6000,                // the prompt is cut to this before it goes to the judge
  "setEffort": true,
  "display": "all",                      // the line under each subagent call: "all" | "changes" | "off"
  "routes": { "easy": {...}, "medium": {...}, "hard": {...} }
}
```

Settings are read from the plugin's `config.json`, then `~/.claude/judge-router/config.json`, then the file
in `$JUDGE_ROUTER_CONFIG`. Later files win, key by key, and `routes` merge by level. Route models can be
aliases (`haiku`, `sonnet`, `opus`, `fable`) or full ids (`claude-opus-5-5` → `opus`). `JUDGE_ROUTER_CLAUDE_BIN`
names another `claude` binary.

How the judge is called: `claude -p --model haiku --tools "" --strict-mcp-config --setting-sources ""
--no-session-persistence --disable-slash-commands --output-format json --system-prompt …`. It runs in a fresh
empty temp folder (removed afterwards) with `JUDGE_ROUTER_INNER=1` in its environment. Loading no settings
files means it loads no plugins, so this hook can't run again inside it, and the env guard covers the rest.

## The log

Every decision is one JSON line in **`~/.claude/judge-router/decisions.jsonl`** (or in `$JUDGE_ROUTER_DIR`):

```json
{"ts":"2026-11-19T11:46:17.930Z","session_id":"e370a8ce-…","tool_use_id":"toolu_016V…","tool":"Agent",
 "description":"trivial echo","subagent_type":"general-purpose",
 "prompt_head":"Reply with exactly the word pong. Do not use any tools.",
 "model_before":"sonnet","effort_before":null,"judge":"cli","judge_ms":2819,
 "difficulty":"easy","confidence":0.99,"why":"The task is a trivial reply of a single fixed word with no tools, requiring no reasoning.",
 "action":"override","model_after":"haiku","effort_after":"low"}
```

`action` is `override` or `unchanged`. `status` is `override`, `unsure`, `failed` or `skipped`, and an
unchanged line has a `reason`. `prompt_head` is the prompt's first
200 characters.

```sh
tail -f ~/.claude/judge-router/decisions.jsonl | jq -c '{description, difficulty, confidence, model_before, model_after, effort_after, why}'
```

## Tests

```sh
npm test            # node --test test/: 40 tests, the judge stubbed (test/fixtures/fake-claude.mjs, a local fake Messages API)
./test/real-run.sh  # the real check below, costs a few cents (same machinery as examples/demo.sh)
```

The unit tests cover: easy, medium and hard prompts; a model and effort already set and then overridden;
`Task` as the tool name; the judge's flags, temp folder and recursion guard; the judge missing, failing,
answering garbage, unsure or too slow; forks and other tools; `CLAUDE_CODE_EFFORT_LEVEL` and
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; config overrides; the API path and its fallback to `claude -p`; the line
shown to the user in each case and each `display` mode; the status line text; the `log.mjs` table, its
`--session` and `--json` options and an empty log.

### Real run (evidence)

`examples/demo.sh` and `test/real-run.sh` run a headless `claude -p --plugin-dir <this folder> --setting-sources ""
--strict-mcp-config --model sonnet` session in a temp folder (`test/headless-run.sh`). Nothing is installed and
no settings files are read. Afterwards `test/run-report.mjs` matches each subagent's tool call, log line and
transcript by `tool_use_id`. The demo run of 2026-11-19 (three subagents in one go, all requesting `sonnet`):

```
| Subagent                 | Requested | Judge verdict | Hook set        | Started with (meta) | Ran on (transcript) |
|--------------------------|-----------|---------------|-----------------|---------------------|---------------------|
| count words              | sonnet    | easy 0.97     | haiku / low     | haiku / low         | claude-haiku-5-5    |
| slugify with tests       | sonnet    | medium 0.9    | sonnet / medium | sonnet / medium     | claude-sonnet-5-5   |
| distributed rate limiter | sonnet    | hard 0.8      | opus / high     | opus / high         | claude-opus-5-5     |

models billed in the session: claude-sonnet-5-5 (2311 output tokens, $0.1006), claude-haiku-5-5 (49 output tokens, $0.0005), claude-opus-5-5 (1251 output tokens, $0.0420)
```

"Started with" comes from each subagent's `agent-*.meta.json` and "Ran on" from the `message.model` of its
responses in `agent-*.jsonl`. The earlier two-subagent `test/real-run.sh` run gave the same result: the echo
subagent ran on `claude-haiku-5-5` at effort low, and the design subagent on `claude-opus-5-5` at effort high.
The main transcript still shows each call as the model wrote it (`model: "sonnet"`), because the hook's change
applies when the tool runs. The hook set no permission decision, and every subagent started normally.
