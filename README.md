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

`action` is `override` or `unchanged`, and an unchanged line has a `reason`. `prompt_head` is the prompt's first
200 characters.

```sh
tail -f ~/.claude/judge-router/decisions.jsonl | jq -c '{description, difficulty, confidence, model_before, model_after, effort_after, why}'
```

## Tests

```sh
npm test            # node --test test/: 28 tests, the judge stubbed (test/fixtures/fake-claude.mjs, a local fake Messages API)
./test/real-run.sh  # the real check below, costs a few cents
```

The unit tests cover: easy, medium and hard prompts; a model and effort already set and then overridden;
`Task` as the tool name; the judge's flags, temp folder and recursion guard; the judge missing, failing,
answering garbage, unsure or too slow; forks and other tools; `CLAUDE_CODE_EFFORT_LEVEL` and
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; config overrides; the API path and its fallback to `claude -p`.

### Real run (evidence)

`test/real-run.sh` runs a headless `claude -p --plugin-dir <this folder> --setting-sources "" --strict-mcp-config
--model sonnet` in a temp folder. Nothing is installed and no settings files are read. The main agent is told
to start two subagents and to set `model: "sonnet"` on both. Output of the run on 2026-11-19:

```
== what the main agent asked for (its Agent tool calls)
{"description":"trivial echo","model":"sonnet","effort":null}
{"description":"hard design","model":"sonnet","effort":null}
== judge-router decisions
{"description":"trivial echo","difficulty":"easy","confidence":0.98,"judge_ms":3055,"model":"sonnet -> haiku","effort":"null -> low",...}
{"description":"hard design","difficulty":"hard","confidence":0.95,"judge_ms":2884,"model":"sonnet -> opus","effort":"null -> high",...}
== session 02a6f620-…: each subagent's metadata and the model on its API responses (~/.claude/projects/…/subagents)
{"description":"hard design","requested_model":"opus","requested_effort":"high","ran_on":"claude-opus-5-5"}
{"description":"trivial echo","requested_model":"haiku","requested_effort":"low","ran_on":"claude-haiku-5-5"}
== models billed in the session (result.modelUsage)
{"claude-sonnet-5-5":{"outputTokens":470,...},"claude-haiku-5-5":{"outputTokens":4,...},"claude-opus-5-5":{"outputTokens":1385,...}}
```

The main agent asked for Sonnet both times. The "pong" subagent ran on **Claude Haiku 5.5** at effort **low**,
and the design subagent on **Claude Opus 5.5** at effort **high**. `requested_*` come from each subagent's
`agent-*.meta.json` and `ran_on` from the `message.model` of its responses in `agent-*.jsonl`. The main
transcript still shows the call as the model wrote it (`model: "sonnet"`), because the hook's change applies
when the tool runs. The hook set no permission decision, and both subagents started normally.
