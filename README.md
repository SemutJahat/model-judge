# model-judge

A Claude Code plugin. Just before Claude Code starts a subagent, a small judge model rates the subagent's
prompt **easy / medium / hard**. The plugin then sets the subagent's **model** and **effort** to match,
replacing whatever the caller or the subagent's definition had set.

It needs nothing besides Claude Code and Node: the judge runs on your own Claude Code login
(`claude -p --model haiku`). When `ANTHROPIC_API_KEY` is set, it calls the Messages API directly, which is faster.

## What it does

Two parts work together; both ship in `hooks/hooks.json`:

1. **A `PreToolUse` hook** on the subagent tool (matcher `Agent|Task`; in Claude Code 2.1.328 the tool is `Agent`,
   `Task` its legacy alias), `scripts/route.mjs`. It sends the call's `prompt`, `description` and `subagent_type`
   to the judge, which answers `{"why", "difficulty", "confidence"}`, logs the decision, and shows you one line
   under the call. It **does not change the call**: no `updatedInput`, no `permissionDecision`. It leaves its
   decision (model, effort) in `~/.claude/model-judge/pending/<tool_use_id>.json`.
2. **A hooks module**, `hooks/register.ts`, which Claude Code runs inside the session. At **`agent.spawn`**, when
   the call has passed every permission check and the subagent is about to start, it takes that decision and
   sets the subagent's **model**. On that subagent's **`turn.step`** (each model request it makes) it sets the
   **effort**. It runs `scripts/spawn.mjs` for the hand-off and logs what was really applied.

Why two parts: auto mode reviews a tool call as the model wrote it, and **refuses a call that a hook rewrote
after that review**. A `PreToolUse` hook that returned `updatedInput` (what model-judge 0.1 did) got every
changed subagent call refused in auto mode, and the model then sent each call a second time. Setting the model
at spawn time leaves the reviewed call untouched. See [Auto mode](#auto-mode-why-the-call-is-not-rewritten).

It also adds a `/model-judge:log` command and ships an optional status line. See
[Seeing what the judge does](#seeing-what-the-judge-does).

Default routes (in `config.json`):

| difficulty | model    | effort   |
|------------|----------|----------|
| easy       | `haiku`  | `low`    |
| medium     | `sonnet` | `medium` |
| hard       | `opus`   | `high`   |

### The override rule

When the judge answers with confidence ≥ the threshold (default **0.75**), its model **always replaces** the
subagent's model, whether the main agent set one, the agent definition's frontmatter set one, or nobody did.
It does this even when the model is the same. `agent.spawn`'s `model` is the Agent call's `model` parameter,
which outranks the definition's `model:` frontmatter and `CLAUDE_CODE_SUBAGENT_MODEL`. The judge's effort
replaces the subagent's effort on every request it makes.

The subagent starts **as asked** (and the hook exits 0) when:

- the judge is unsure (confidence < threshold);
- the judge fails: `claude` not found, it exits non-zero, or its answer isn't the expected JSON;
- the judge takes longer than `timeoutMs` (default **15 s**); the judge is killed;
- the subagent is a `fork`, since Claude Code ignores model and effort for forks;
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, since Claude Code then removes `model` from the tool;
- the hook runs inside the judge itself (`MODEL_JUDGE_INNER=1`, the recursion guard).

It never blocks a subagent: every path exits 0, the module's `agent.spawn` hook starts the subagent as asked
if anything in it fails, and any error only leaves the call as it was.

The same call judged again within `cacheTtlMs` (default 10 minutes) reuses the verdict instead of paying the
judge again: the log says `"judge": "cache"`, and the line shows `(0.0s)`. The cache key covers the judge's
model, its instructions and the task text (prompt, description, subagent type), and failed calls are not
cached. It lives in `~/.claude/model-judge/cache.json`.

## Auto mode: why the call is not rewritten

What model-judge 0.1 did, and what happened in auto mode (reproduced in a headless `claude -p --permission-mode
auto` run of `examples/prompts/mixed.md`): all three Agent calls came back with

> The server-side auto mode classifier gave no verdict for Agent: a hook changed this call's input after auto
> mode reviewed it, so the review does not cover what would run. This is not a judgment that the action is
> unsafe. The hook produced this input: {"description":"count words",…,"model":"haiku","effort":"low",…}

The same refusal came for `slugify with tests` (sonnet→sonnet), because adding `effort` alone changes the input.
Claude Code's text tells the model to "issue the call once more with exactly that input". So the model sent all
three again, and the hook judged them again: 6 Agent calls and 6 judge calls for 3 subagents. In the owner's
session, the second round carried the hook's own model and effort, so the hook changed nothing and the calls
ran. In the headless run, the second round asked for `sonnet` again and was refused again.

This is by design in Claude Code 2.1.328. Auto mode's classifier reviews each tool call server-side, as the
model wrote it, so any `updatedInput` voids the review. A `permissionDecision` of `"allow"` with
`updatedInput` doesn't help: in auto mode a hook's allow is still sent to the classifier ("auto mode requires
classifier adjudication"), which has only seen the original input. And an `"allow"` would skip the user's
permission prompts in the other modes, which model-judge must not do.

The fix uses the hooks-module events that Claude Code 2.1.328 gives plugins for this:
- **`agent.spawn`:** "A hook sets this to pick the subagent's model". It runs after the call was reviewed
  and allowed.
- **`turn.step`:** "A hook rewrites `model` or `effort` going down", for one model request.

Neither event changes the tool call, so no review is voided, and nothing is approved that wouldn't be anyway.
Tested in real headless runs of the mixed prompt in each permission mode, with 3 subagents requesting `sonnet`:

| mode | Agent calls | refused | judge calls | first requests (model / effort) |
|---|---|---|---|---|
| auto (0.1, before) | 6 | 6 | 6 | none ran |
| default | 3 | 0 | 3 | haiku/low · sonnet/medium · opus/high |
| acceptEdits | 3 | 0 | 3 | haiku/low · sonnet/medium · opus/high |
| auto | 3 | 0 | 3 | haiku/low · sonnet/medium · opus/high |
| bypassPermissions | 3 | 0 | 3 | haiku/low · sonnet/medium · opus/high |

An interactive session in auto mode, using the installed plugin, gave the same result (see
[Seeing what the judge does](#seeing-what-the-judge-does)).

**Older Claude Code.** The module needs hook modules (`agent.spawn`, `turn.step`), which Claude Code 2.1.328
has. On a version without them, set `"apply": "input"` in the config. That brings back the 0.1 behaviour
(`updatedInput` on the call), which works in default, acceptEdits and bypassPermissions modes but not in auto.

## Effort: it is set per request

`agent.spawn` takes no effort, but `turn.step` does: each model request of a subagent passes through it, and a
hook may set its `effort` (`low | medium | high | xhigh | max`). The module remembers the effort for each
subagent it started (by `agentId`) and sets it on every request that subagent makes. After the first request,
it reads what that request really carried (`$.agent.list()`'s `lastRequest`, "the request as it went out, past
caps, fallbacks and a hook's rewrite") and logs it as a `"request"` line. That is the evidence the effort
reached the API. The real runs above show low / medium / high there.

Limits found in Claude Code:

- Since the call isn't rewritten, a subagent's `meta.json` in the transcript shows the model but no effort
  (`effort: null`). The `"request"` lines in the log show the effort that was sent.
- **`CLAUDE_CODE_EFFORT_LEVEL`** pins the session's effort. When it is set (to anything but `auto`/`unset`),
  model-judge sets only the model and leaves effort alone (the log notes it).
- The module's effort table lives in its memory: if Claude Code reloads the plugin while a subagent runs,
  that subagent's later requests go back to their default effort, but its model stays.
- Forks inherit the parent's model and effort, and the hook doesn't touch them.

## Latency

Each routed subagent waits for one judge call before it starts. Measured on this Mac (macOS, Claude Code
2.1.328, judge `claude -p --model haiku` → Claude Haiku 5.5, no API key), over 12 real calls:
**2.7 s to 4.2 s, median ≈ 3.2 s**, about $0.0002 per call. A bare `claude -p` judge call timed with `time`:
3.07 s wall, of which the model took 2.0 s (`duration_ms`). The API path skips the CLI's start-up and should be
faster, but no API key was available here to time it. A cache hit (the same call within 10 minutes) costs
nothing: no judge call. The module's hand-off adds two short `node` runs per subagent (about 50 ms each).

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
  ⎿  PreToolUse:Agent says: ⚖ model-judge: "count words" → easy 0.97 · sonnet→haiku · effort low (3.4s)
  ⎿  PreToolUse:Agent says: ⚖ model-judge: "slugify with tests" → medium 0.85 · sonnet→sonnet · effort medium (2.7s)
  ⎿  PreToolUse:Agent says: ⚖ model-judge: "rate limiter design" → hard 0.85 · sonnet→opus · effort high (4.3s)
  ⎿  PreToolUse:Agent says: ⚖ model-judge: "vague task" unsure 0.40 (easy?) → left as sonnet (3.5s)
```

The subagents' transcripts confirm it: `count words` ran on `claude-haiku-5-5` (effort low), `slugify with tests`
on `claude-sonnet-5-5` (medium), `rate limiter design` on `claude-opus-5-5` (high), and `vague task` stayed on
`claude-sonnet-5-5` with no effort set.

In **auto mode**, with the plugin installed (`claude --permission-mode auto --model sonnet`, the mixed prompt),
the capture shows one launch, no refusals, and model-judge's status line at the bottom:

```
⏺ 3 background agents launched (↓ to manage)
   ├ count words
   ├ slugify with tests
   └ distributed rate limiter
  ⎿  PreToolUse:Agent says: ⚖ model-judge: "count words" → easy 0.97 · sonnet→haiku · effort low (3.1s)
  ⎿  PreToolUse:Agent says: ⚖ model-judge: "slugify with tests" → medium 0.90 · sonnet→sonnet · effort medium (4.0s)
  ⎿  PreToolUse:Agent says: ⚖ model-judge: "distributed rate limiter" → hard 0.90 · sonnet→opus · effort high (3.0s)
…
⏺ Agent "distributed rate limiter" finished · 24s
──────────────────────────────────────────────
❯
──────────────────────────────────────────────
  ⚖ opus/high · hard 0.90 · "distributed rate limiter"
  ⏵⏵ auto mode on (shift+tab to cycle) · /tasks to see subagents
```

The other forms of the line:

```
⚖ model-judge: "x" judge failed (cli: claude -p timed out after 15000 ms) → left as sonnet (15.0s)
⚖ model-judge: "x" skipped (fork) → left as default
```

`"display"` in `config.json` sets how much it says:
- `"all"` (default): every decision.
- `"changes"`: only when the model or effort changed, or the judge failed.
- `"off"`: nothing; the log still records everything.

When the input is left unchanged, the hook prints only `{"systemMessage": …}`, with no `hookSpecificOutput`.

### 2. `/model-judge:log [N]`, and the same in a terminal

The plugin adds a slash command, `/model-judge:log`. It runs `scripts/log.mjs` and shows the last N decisions,
10 by default. It runs `node` only, which its `allowed-tools` frontmatter permits, so it asks for no permission.
Captured from the interactive session:

```
❯ /model-judge:log
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
In a terminal, with no model involved (from a clone of this repo, or the installed copy's folder):

```sh
node scripts/log.mjs            # last 10 (or: log.mjs 25, -n 25)
node scripts/log.mjs --watch    # then follow new decisions live, in another terminal
node scripts/log.mjs --session SESSION_ID --json
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
for you. A status line is a command in `~/.claude/settings.json`, and an installed plugin's folder changes with
each version, so point it at the stable launcher instead. `scripts/statusline-launcher.mjs` finds the installed
model-judge (its `installPath` in `~/.claude/plugins/installed_plugins.json`) and runs that version's
`statusline.mjs`. To opt in, copy the launcher out of the plugin once:

```sh
mkdir -p ~/.claude/model-judge
cp "$(jq -r '.plugins["model-judge@claude-judge"][0].installPath' ~/.claude/plugins/installed_plugins.json)/scripts/statusline-launcher.mjs" \
   ~/.claude/model-judge/statusline.mjs
```

Then add this to `~/.claude/settings.json`, with your home folder in the path:

```json
"statusLine": { "type": "command", "command": "node /Users/YOU/.claude/model-judge/statusline.mjs" }
```

To try it for one session without editing any settings file:
`claude --settings '{"statusLine":{"type":"command","command":"node /Users/YOU/.claude/model-judge/statusline.mjs"}}'`.
If you already have a status line, call both from one command, and pass the same stdin to each:
`sh -c 'i=$(cat); printf %s "$i" | your-statusline; printf " "; printf %s "$i" | node …/statusline.mjs'`.

To remove it, delete the `"statusLine"` entry from `~/.claude/settings.json` (and, if you like,
`~/.claude/model-judge/statusline.mjs`). New sessions then show no status line.

## Try it yourself

None of these install anything. They use the plugin straight from a clone of this repo
(`git clone https://github.com/SemutJahat/claude-judge && cd claude-judge`).

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
claude --plugin-dir .          # from the clone
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

**Watching while you try.** In an interactive session, each subagent call shows its model-judge line (see
[Seeing what the judge does](#seeing-what-the-judge-does)). Type `/model-judge:log` for the table, or keep
`node scripts/log.mjs --watch` running in a second terminal.

**Reading the log.** Every subagent the hook sees in a normal session adds a line to
`~/.claude/model-judge/decisions.jsonl` (the demo writes to its temp folder instead). Use `node scripts/log.mjs`
for a table, or `jq` for the raw lines:

```sh
jq -c '{ts, description, difficulty, confidence, model: "\(.model_before) -> \(.model_after)", effort_after, action, reason}' ~/.claude/model-judge/decisions.jsonl | tail
```

**Seeing the real model in a subagent's transcript.** Claude Code keeps each subagent's transcript next to the
session's, in `~/.claude/projects/<project folder>/<session id>/subagents/`:

```sh
S=$(echo ~/.claude/projects/*/SESSION_ID/subagents)   # SESSION_ID: from the log line's session_id
cat $S/agent-*.meta.json                    # {"description":…, "model":"haiku", "effort":null, "toolUseId":…}
jq -r 'select(.type=="assistant") | .message.model' $S/agent-*.jsonl | sort | uniq -c   # e.g. claude-haiku-5-5
```

`toolUseId` in `meta.json` is the `tool_use_id` of the log line, so the two can be matched. `meta.json`'s
`effort` stays `null`, because the effort is set per request, not on the call. The log's `"request"` line
for the subagent (matched by `agent_id`) shows the effort its first request carried.

## Install / uninstall

The repo is its own marketplace, named `claude-judge`. To install model-judge for your user (all your Claude
Code sessions), from a terminal:

```sh
claude plugin marketplace add SemutJahat/claude-judge
claude plugin install model-judge@claude-judge --scope user
claude plugin list                     # model-judge@claude-judge … Scope: user · Status: ✔ enabled
```

Or at the Claude Code prompt: `/plugin install model-judge --marketplace SemutJahat/claude-judge`.
New sessions load the plugin; sessions that are already open don't. It needs Claude Code with hook modules
(2.1.328 has them; see [Older Claude Code](#auto-mode-why-the-call-is-not-rewritten)), Node on the PATH, and
your Claude Code login, which the judge uses.

Claude Code installs a copy of the plugin in `~/.claude/plugins/cache/claude-judge/model-judge/<version>/`
and runs it from there. To get a newer version after the repo changes:

```sh
claude plugin marketplace update claude-judge     # fetch the repo's latest marketplace and plugin
claude plugin update model-judge@claude-judge    # then open a new session
```

To turn it off for a while, or remove it:

```sh
claude plugin disable model-judge@claude-judge --scope user    # off; on again: claude plugin enable model-judge@claude-judge --scope user
claude plugin uninstall model-judge@claude-judge --scope user  # remove the plugin
claude plugin marketplace remove claude-judge                   # remove the marketplace
```

To try it for one session without installing anything, from a clone: `claude --plugin-dir .`

**Developing it.** A clone added as a local marketplace (`claude plugin marketplace add ./claude-judge`) is read
straight from that folder, not from a copy. Edits apply without reinstalling: `scripts/` and `config.json` from
the next subagent call, and `hooks/` and `commands/` from the next new session.

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
  "apply": "spawn",                      // "spawn": set at agent.spawn/turn.step (works in auto mode); "input": 0.1's updatedInput
  "cacheTtlMs": 600000,                  // reuse a verdict for the same call for 10 min; 0 turns the cache off
  "routes": { "easy": {...}, "medium": {...}, "hard": {...} }
}
```

An installed plugin is a copy that each update replaces, so put your own settings in
`~/.claude/model-judge/config.json`, which only needs the keys you change (e.g. `{"display": "changes"}`).
Settings are read from the plugin's `config.json`, then `~/.claude/model-judge/config.json`, then the file
in `$MODEL_JUDGE_CONFIG`. Later files win, key by key, and `routes` merge by level. Route models can be
aliases (`haiku`, `sonnet`, `opus`, `fable`) or full ids (`claude-opus-5-5` → `opus`). `MODEL_JUDGE_CLAUDE_BIN`
names another `claude` binary.

How the judge is called: `claude -p --model haiku --tools "" --strict-mcp-config --setting-sources ""
--no-session-persistence --disable-slash-commands --output-format json --system-prompt …`. It runs in a fresh
empty temp folder (removed afterwards) with `MODEL_JUDGE_INNER=1` in its environment. Loading no settings
files means it loads no plugins, so this hook can't run again inside it, and the env guard covers the rest.

## The log

Every decision is one JSON line in **`~/.claude/model-judge/decisions.jsonl`** (or in `$MODEL_JUDGE_DIR`):

```json
{"ts":"2026-11-19T11:46:17.930Z","session_id":"e370a8ce-…","tool_use_id":"toolu_016V…","tool":"Agent",
 "description":"trivial echo","subagent_type":"general-purpose",
 "prompt_head":"Reply with exactly the word pong. Do not use any tools.",
 "model_before":"sonnet","effort_before":null,"judge":"cli","judge_ms":2819,
 "difficulty":"easy","confidence":0.99,"why":"The task is a trivial reply of a single fixed word with no tools, requiring no reasoning.",
 "action":"override","model_after":"haiku","effort_after":"low"}
```

`action` is `override` or `unchanged`. `status` is `override`, `unsure`, `failed` or `skipped`, and an
unchanged line has a `reason`. `prompt_head` is the prompt's first 200 characters. `judge` is `cli`, `api` or
`cache`. `apply` is `spawn` or `input`.

The hooks module adds two lines per routed subagent, with an `event` field (the views skip them):

```json
{"event":"applied","tool_use_id":"toolu_…","agent_id":"a168964b54e9438ea","model":"claude-haiku-5-5","effort":"low"}
{"event":"request","agent_id":"a168964b54e9438ea","model":"claude-haiku-5-5","effort":"low","wanted":"low"}
```

`applied` is written at `agent.spawn`, and `model` is what Claude Code resolved for the subagent. `request` is
what its first model request really carried. A decision with no `applied` line shows as `pending` in
`log.mjs`, meaning the module didn't apply it (for example, because hook modules aren't available).

```sh
tail -f ~/.claude/model-judge/decisions.jsonl | jq -c '{description, difficulty, confidence, model_before, model_after, effort_after, why}'
```

## Tests

```sh
npm test            # node --test test/: 49 tests, the judge stubbed (test/fixtures/fake-claude.mjs, a local fake Messages API)
./test/real-run.sh  # the real check below, costs a few cents (same machinery as examples/demo.sh)
```

The unit tests cover: easy, medium and hard prompts; a model and effort already set and then overridden;
`Task` as the tool name; the judge's flags, temp folder and recursion guard; the judge missing, failing,
answering garbage, unsure or too slow; forks and other tools; `CLAUDE_CODE_EFFORT_LEVEL` and
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; config overrides; the API path and its fallback to `claude -p`; the line
shown to the user in each case and each `display` mode; the status line text; the `log.mjs` table, its
`--session` and `--json` options and an empty log.

### Real run (evidence)

`examples/demo.sh` and `test/real-run.sh` run a headless `claude -p --plugin-dir <the clone> --setting-sources ""
--strict-mcp-config --model sonnet` session in a temp folder (`test/headless-run.sh`; set `PERMISSION_MODE` to
pick the mode). Nothing is installed and no settings files are read. Afterwards `test/run-report.mjs` matches
each Agent call's tool call, result, log lines and transcript by `tool_use_id`. Here is the auto-mode run of
2026-11-19 (three subagents in one go, all requesting `sonnet`):

```
| Subagent                 | Requested | Judge verdict | Decision        | Call | Started on (agent.spawn) | First request (model / effort) | Ran on (transcript) |
|--------------------------|-----------|---------------|-----------------|------|--------------------------|--------------------------------|---------------------|
| count words              | sonnet    | easy 0.97     | haiku / low     | ran  | claude-haiku-5-5         | claude-haiku-5-5 / low         | claude-haiku-5-5    |
| slugify with tests       | sonnet    | medium 0.9    | sonnet / medium | ran  | claude-sonnet-5-5        | claude-sonnet-5-5 / medium     | claude-sonnet-5-5   |
| distributed rate limiter | sonnet    | hard 0.9      | opus / high     | ran  | claude-opus-5-5          | claude-opus-5-5 / high         | claude-opus-5-5     |
Agent calls: 3 for 3 subagent task(s); refused: 0; judge calls: 3 (+0 from cache)
```

How to read the columns:
- **Started on:** the `applied` log line, written at `agent.spawn`.
- **First request:** the `request` log line, the model and effort as sent.
- **Ran on:** the `message.model` of the subagent's responses in its `agent-*.jsonl`.

The main transcript still shows each call as the model wrote it (`model: "sonnet"`), and that is the point: the
call isn't rewritten, so auto mode's review of it holds. The default, acceptEdits and bypassPermissions runs
gave the same table.
