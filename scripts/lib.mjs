// model-judge: the logic of the PreToolUse hook (and of the opt-in UserPromptSubmit delegation nudge),
// kept free of process I/O so tests can drive it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, appendFileSync, existsSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// What the Agent tool's `model` and `effort` fields accept in Claude Code 2.1.328
// (zod enums in the binary: model ["sonnet","opus","haiku","fable"], effort ["low","medium","high","xhigh","max"]).
export const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

export const DEFAULT_CONFIG = {
  judgeModel: 'haiku',
  judgeApiModel: 'claude-haiku-5-5',
  useApiKey: true,
  confidenceThreshold: 0.75,
  timeoutMs: 15000,
  maxPromptChars: 6000,
  setEffort: true,
  display: 'all',
  apply: 'spawn',
  cacheTtlMs: 600000,
  claudeBin: 'claude',
  // The delegation nudge (UserPromptSubmit, scripts/nudge.mjs): off unless turned on.
  delegationNudge: 'off',
  nudgeMinChars: 80,            // shorter prompts (follow-ups, "yes", "go on") are never judged
  nudgeMinDifficulty: 'medium', // the whole task must be at least this hard
  nudgeMinConfidence: 0.7,
  nudgeMinParts: 2,             // and split into at least this many independent parts
  routes: {
    easy: { model: 'haiku', effort: 'low' },
    medium: { model: 'sonnet', effort: 'medium' },
    hard: { model: 'opus', effort: 'high' },
  },
};

export function dataDir(env = process.env) {
  return env.MODEL_JUDGE_DIR || join(homedir(), '.claude', 'model-judge');
}

// Config: the plugin's config.json, then ~/.claude/model-judge/config.json (survives reinstalls),
// then the file named by MODEL_JUDGE_CONFIG. Later ones win, key by key (routes merged per level).
export function loadConfig(env = process.env) {
  let cfg = structuredClone(DEFAULT_CONFIG);
  const files = [join(PLUGIN_ROOT, 'config.json'), join(dataDir(env), 'config.json')];
  if (env.MODEL_JUDGE_CONFIG) files.push(env.MODEL_JUDGE_CONFIG);
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      cfg = { ...cfg, ...c, routes: { ...cfg.routes, ...(c.routes || {}) } };
    } catch { /* a broken config file is ignored, never fatal */ }
  }
  if (env.MODEL_JUDGE_CLAUDE_BIN) cfg.claudeBin = env.MODEL_JUDGE_CLAUDE_BIN;
  return cfg;
}

// "claude-opus-5-5", "Opus", "opus" -> "opus"; anything unknown -> undefined.
export function toModelAlias(m) {
  if (typeof m !== 'string') return undefined;
  const s = m.toLowerCase();
  return MODEL_ALIASES.find((a) => s === a || s.includes(a));
}

export function toEffort(e) {
  return typeof e === 'string' && EFFORTS.includes(e.toLowerCase()) ? e.toLowerCase() : undefined;
}

export const JUDGE_SYSTEM = `You rate how hard a task given to a coding subagent is, to pick the model that runs it.
easy: mechanical work that needs almost no reasoning: count or look something up, grep-and-report, a rename or one-line edit, repeat or summarize given text.
medium: ordinary engineering that needs real but bounded reasoning: write new code (a function, a module, a script) that must handle edge cases, write tests, a fix or feature across a few files, a focused review, a moderate investigation. Any task that asks for new code plus its edge cases or its tests is medium, never easy, however small the function.
hard: open-ended or deep work: system or architecture design and its trade-offs, distributed systems, subtle concurrency or security, hard debugging, broad refactors, research needing judgment.
Examples:
- "Count the words in this sentence" -> easy
- "Find where MAX_RETRIES is defined and report the file" -> easy
- "Write a parse_duration(s) function that handles units, bad input and empty strings, with unit tests" -> medium
- "Write a slugify function handling unicode and repeated separators, with pytest tests" -> medium
- "Add a /health endpoint with a test" -> medium
- "Design a distributed rate limiter and explain its trade-offs" -> hard
confidence: how sure you are of the difficulty. If the task is too vague or lacks the context to tell what work it means (e.g. "fix it", "look into it"), the difficulty is a guess: give a confidence below 0.5.
First say why in one short sentence, then decide. Reply with ONLY a JSON object, no prose, no code fence:
{"why":"<one short sentence>","difficulty":"easy"|"medium"|"hard","confidence":<0..1>}`;

export function judgeUserPrompt(input, maxChars = 6000) {
  let prompt = String(input.prompt ?? '');
  if (prompt.length > maxChars) prompt = prompt.slice(0, maxChars) + '\n[... truncated]';
  return [
    'Rate this subagent task.',
    `Description: ${input.description ?? ''}`,
    `Subagent type: ${input.subagent_type ?? 'general-purpose (default)'}`,
    'Prompt:',
    '<<<',
    prompt,
    '>>>',
  ].join('\n');
}

// Pull the first JSON object out of the judge's text and check it.
export function parseVerdict(text, levels) {
  if (typeof text !== 'string') return { error: 'judge returned no text' };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'judge reply has no JSON object' };
  let v;
  try { v = JSON.parse(text.slice(start, end + 1)); } catch { return { error: 'judge reply is not valid JSON' }; }
  const difficulty = typeof v.difficulty === 'string' ? v.difficulty.toLowerCase().trim() : '';
  if (!levels.includes(difficulty)) return { error: `judge gave an unknown difficulty: ${JSON.stringify(v.difficulty)}` };
  const confidence = Number(v.confidence);
  if (!Number.isFinite(confidence)) return { error: 'judge gave no numeric confidence' };
  return { difficulty, confidence, why: typeof v.why === 'string' ? v.why : '' };
}

// ---- the judges -------------------------------------------------------------------------------

async function judgeViaApi(userPrompt, cfg, env, timeoutMs, system = JUDGE_SYSTEM) {
  const res = await fetch((env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.judgeApiModel,
      max_tokens: system === JUDGE_SYSTEM ? 300 : 700,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// `claude -p` on the user's own login: no tools, no MCP, no settings (so no plugins, so not this hook),
// no session saved, in an empty temp folder (a neutral name: the model sees its working folder), with MODEL_JUDGE_INNER=1 as a second guard against recursion.
export function judgeViaCli(userPrompt, cfg, env, timeoutMs, system = JUDGE_SYSTEM) {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'task-'));
    const args = [
      '-p', '--model', cfg.judgeModel,
      '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--no-session-persistence', '--disable-slash-commands',
      '--output-format', 'json', '--system-prompt', system,
    ];
    let out = '', err = '', done = false;
    const child = spawn(cfg.claudeBin, args, {
      cwd,
      env: { ...env, MODEL_JUDGE_INNER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { rmSync(cwd, { recursive: true, force: true }); } catch {}
      fn(val);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(reject, new Error(`claude -p timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`claude -p exited ${code}: ${(err || out).trim().slice(0, 200)}`));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return finish(reject, new Error(`claude -p error: ${String(j.result).slice(0, 200)}`));
        finish(resolve, String(j.result ?? ''));
      } catch {
        finish(resolve, out); // not the json envelope: let parseVerdict try the raw text
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(userPrompt);
  });
}

// Ask the judge: the API when ANTHROPIC_API_KEY is set (faster), else (or if that fails) `claude -p`.
// Never throws: returns { verdict } or { error }, plus which judge answered and how long it took.
export async function askJudge(input, cfg, env = process.env, impl = { api: judgeViaApi, cli: judgeViaCli }) {
  const levels = Object.keys(cfg.routes);
  return askModel(judgeUserPrompt(input, cfg.maxPromptChars), JUDGE_SYSTEM, (text) => parseVerdict(text, levels), cfg, env, impl);
}

// One judge question (a system prompt, a user prompt, a parser of the reply) through the API, then `claude -p`.
async function askModel(userPrompt, system, parse, cfg, env, impl) {
  const t0 = Date.now();
  const deadline = t0 + cfg.timeoutMs;
  const errors = [];
  const tries = [];
  if (cfg.useApiKey && env.ANTHROPIC_API_KEY) tries.push('api');
  tries.push('cli');
  for (const kind of tries) {
    const left = deadline - Date.now();
    if (left < 500) { errors.push(`${kind}: no time left`); break; }
    try {
      const text = await impl[kind](userPrompt, cfg, env, left, system);
      const v = parse(text);
      if (v.error) { errors.push(`${kind}: ${v.error}`); continue; }
      return { verdict: v, judge: kind, ms: Date.now() - t0 };
    } catch (e) {
      errors.push(`${kind}: ${e?.message || e}`);
    }
  }
  return { error: errors.join('; '), ms: Date.now() - t0 };
}

// ---- verdict cache ----------------------------------------------------------------------------

// The same call judged again within cacheTtlMs (a retry, a re-sent call) reuses the verdict instead of paying
// the judge again. The key covers everything the judge sees: its model, its instructions and the task text.
export function cacheKey(input, cfg) {
  return createHash('sha256')
    .update(JSON.stringify([cfg.judgeModel, cfg.judgeApiModel, JUDGE_SYSTEM, judgeUserPrompt(input, cfg.maxPromptChars)]))
    .digest('hex').slice(0, 32);
}

function readCache(env) {
  try { return JSON.parse(readFileSync(join(dataDir(env), 'cache.json'), 'utf8')); } catch { return {}; }
}

function writeCache(cache, env) {
  try {
    const dir = dataDir(env);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `cache.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, join(dir, 'cache.json')); // atomic: concurrent hooks never read half a file
  } catch { /* a cache that can't be written is only slower */ }
}

export async function askJudgeCached(input, cfg, env = process.env, judge = askJudge, now = Date.now) {
  return withCache(cacheKey(input, cfg), () => judge(input, cfg, env), cfg, env, now);
}

// The cache both judges share (cache.json): `run` is called on a miss and its verdict kept for cacheTtlMs.
async function withCache(key, run, cfg, env, now) {
  const ttl = Number(cfg.cacheTtlMs) || 0;
  if (ttl <= 0) return run();
  const hit = readCache(env)[key];
  if (hit && now() - hit.at < ttl && hit.verdict) return { verdict: hit.verdict, judge: 'cache', ms: 0, cachedFrom: hit.judge };
  const r = await run();
  if (r.verdict) {
    const cache = readCache(env);
    for (const [k, v] of Object.entries(cache)) if (!(now() - v.at < ttl)) delete cache[k];
    cache[key] = { at: now(), verdict: r.verdict, judge: r.judge };
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete cache[k];
    writeCache(cache, env);
  }
  return r;
}

// ---- hand-off to the hooks module ------------------------------------------------------------

// apply "spawn": the PreToolUse hook leaves the tool call as written (so auto mode's review of it stays valid)
// and leaves its decision here; the plugin's hooks module (hooks/register.ts) takes it at agent.spawn, sets the
// subagent's model there and its effort on the subagent's model requests (turn.step).
function pendingPath(toolUseId, env) {
  const id = String(toolUseId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return id ? join(dataDir(env), 'pending', `${id}.json`) : undefined;
}

export function writeHandoff(toolUseId, decision, env = process.env) {
  const f = pendingPath(toolUseId, env);
  if (!f) return false;
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ ...decision, at: Date.now() }));
    return true;
  } catch { return false; }
}

// Read and remove a call's decision; also sweeps hand-offs older than an hour (calls that never spawned).
export function takeHandoff(toolUseId, env = process.env, now = Date.now) {
  const f = pendingPath(toolUseId, env);
  let d;
  if (f && existsSync(f)) {
    try { d = JSON.parse(readFileSync(f, 'utf8')); } catch {}
    try { rmSync(f, { force: true }); } catch {}
  }
  try {
    const dir = join(dataDir(env), 'pending');
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (now() - statSync(p).mtimeMs > 3600000) rmSync(p, { force: true });
    }
  } catch {}
  return d;
}

// ---- the decision -----------------------------------------------------------------------------

// Can this session's Agent tool take the field at all? Claude Code drops `model` from the schema when
// CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set and `effort` when CLAUDE_CODE_EFFORT_LEVEL pins one; a field the
// schema lacks could fail validation, and a hook input failing validation denies the call. So: leave it out.
export function fieldsAllowed(env = process.env) {
  const lvl = (env.CLAUDE_CODE_EFFORT_LEVEL || '').toLowerCase();
  return {
    model: !env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE,
    effort: !(lvl && lvl !== 'unset' && lvl !== 'auto'),
  };
}

// Returns { output, log, handoff? }: output is the hook's stdout object, or null for "say and change nothing".
// When config.display allows it, output carries a systemMessage: the one line Claude Code shows the user.
export async function decide(hookInput, opts = {}) {
  const cfg = opts.cfg ?? loadConfig(opts.env ?? process.env);
  const r = await decideCore(hookInput, { ...opts, cfg });
  const message = formatMessage(r.log, cfg);
  if (message) r.output = { ...(r.output ?? {}), systemMessage: message };
  return r;
}

async function decideCore(hookInput, { env = process.env, cfg = loadConfig(env), judge = askJudgeCached } = {}) {
  const tool = hookInput?.tool_name;
  const input = hookInput?.tool_input;
  const log = {
    ts: new Date().toISOString(),
    session_id: hookInput?.session_id,
    tool_use_id: hookInput?.tool_use_id,
    tool,
    description: input?.description,
    subagent_type: input?.subagent_type,
    prompt_head: typeof input?.prompt === 'string' ? input.prompt.slice(0, 200) : undefined,
    model_before: input?.model ?? null,
    effort_before: input?.effort ?? null,
  };
  // status says why it is unchanged: guard | not-agent | skipped | failed | unsure (the message differs).
  const unchanged = (reason, extra = {}, status = 'skipped') => ({
    output: null,
    log: { ...log, ...extra, action: 'unchanged', status, reason, model_after: log.model_before, effort_after: log.effort_before },
  });

  if (env.MODEL_JUDGE_INNER === '1') return unchanged('inside the judge itself (recursion guard)', {}, 'guard');
  if (!SUBAGENT_TOOLS.has(tool) || !input || typeof input !== 'object') return unchanged(`not a subagent tool: ${tool}`, {}, 'not-agent');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return unchanged('subagent has no prompt');
  if (input.subagent_type === 'fork') return unchanged('fork: Claude Code ignores model and effort for forks');
  const allowed = fieldsAllowed(env);
  if (!allowed.model) return unchanged('CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set: the Agent tool takes no model');

  const r = await judge(input, cfg, env);
  const jlog = { judge: r.judge ?? null, judge_ms: r.ms, ...(r.cachedFrom ? { cached_from: r.cachedFrom } : {}) };
  if (r.error) return unchanged(`judge failed: ${r.error}`, jlog, 'failed');
  const { difficulty, confidence, why } = r.verdict;
  Object.assign(jlog, { difficulty, confidence, why });
  if (confidence < cfg.confidenceThreshold) {
    return unchanged(`judge unsure: confidence ${confidence} < ${cfg.confidenceThreshold}`, jlog, 'unsure');
  }
  const route = cfg.routes[difficulty] || {};
  const model = toModelAlias(route.model);
  if (!model) return unchanged(`config route for ${difficulty} has no usable model: ${JSON.stringify(route.model)}`, jlog);
  const effort = cfg.setEffort && allowed.effort ? toEffort(route.effort) : undefined;

  // The override rule: the judge's model always replaces what the caller or definition set.
  const applyMode = cfg.apply === 'input' ? 'input' : 'spawn';
  let output = null, handoff;
  if (applyMode === 'input') {
    // Legacy: rewrite the tool call. Auto mode refuses a call a hook rewrote after its review.
    const updated = { ...input, model };
    if (effort) updated.effort = effort;
    // No permissionDecision on purpose: the call goes through Claude Code's normal permission check.
    output = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } };
  } else {
    handoff = { model, ...(effort ? { effort } : {}), difficulty, confidence };
  }

  return {
    output,
    handoff,
    log: {
      ...log, ...jlog,
      action: 'override',
      status: 'override',
      apply: applyMode,
      model_after: model,
      effort_after: effort ?? log.effort_before,
      ...(cfg.setEffort && !allowed.effort ? { note: 'CLAUDE_CODE_EFFORT_LEVEL pins effort: effort left alone' } : {}),
    },
  };
}

// ---- what the user sees ----------------------------------------------------------------------

// display: "all" (every decision, default) | "changes" (only when the model or effort changed, or the judge
// failed) | "off". Returns the one-line message, or undefined for none.
export function formatMessage(log, cfg = DEFAULT_CONFIG) {
  const mode = cfg.display ?? 'all';
  if (mode === 'off' || mode === false) return undefined;
  if (log.status === 'guard' || log.status === 'not-agent' || !log.status) return undefined;
  const name = `"${clip(log.description || 'subagent', 48)}"`;
  const before = log.model_before ?? 'default';
  const secs = typeof log.judge_ms === 'number' ? ` (${(log.judge_ms / 1000).toFixed(1)}s)` : '';
  const conf = typeof log.confidence === 'number' ? log.confidence.toFixed(2) : '';
  if (log.status === 'override') {
    const changed = log.model_after !== log.model_before || log.effort_after !== log.effort_before;
    if (mode === 'changes' && !changed) return undefined;
    const effort = log.effort_after ? ` · effort ${log.effort_after}` : '';
    return `⚖ model-judge: ${name} → ${log.difficulty} ${conf} · ${before}→${log.model_after}${effort}${secs}`;
  }
  if (log.status === 'unsure') {
    if (mode === 'changes') return undefined;
    return `⚖ model-judge: ${name} unsure ${conf} (${log.difficulty}?) → left as ${before}${secs}`;
  }
  if (log.status === 'failed') {
    return `⚖ model-judge: ${name} judge failed (${clip(String(log.reason).replace(/^judge failed: /, ''), 80)}) → left as ${before}${secs}`;
  }
  if (mode === 'changes') return undefined;
  return `⚖ model-judge: ${name} skipped (${clip(String(log.reason).split(':')[0], 60)}) → left as ${before}`;
}

function clip(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function writeLog(entry, env = process.env) {
  try {
    const dir = dataDir(env);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'decisions.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* logging must never break a subagent */ }
}

// ---- the delegation nudge (UserPromptSubmit) ----------------------------------------------------
//
// Opt-in ("delegationNudge": "on"). Before the main agent sees a prompt, the same judge rates the whole task and
// lists the parts of it that could run independently. Only when the task is hard enough and splits into enough
// parts does the hook add context suggesting the main agent delegate them to subagents. It never blocks the
// prompt and never forces anything: no output means the prompt goes on untouched.

export const NUDGE_SYSTEM = `You help a coding agent decide whether to hand parts of the user's request to subagents.
A subagent starts with a fresh, empty context and works on its own, in parallel with others. That pays off only for big work that splits into parts which do not depend on each other; for small or tightly coupled work it only adds overhead.
Rate the request's overall difficulty:
easy: a quick answer, a lookup, a one-line or one-place change, conversation, a question answered from general knowledge.
medium: ordinary engineering with bounded reasoning: a feature or fix across a few files, new code with tests, a focused review or investigation.
hard: open-ended or deep work: design, broad refactors, hard debugging, research needing judgment.
Then list the parts that could be done independently, at the same time, by separate agents that share nothing:
- independent: changes to separate files or modules that don't depend on each other; several separate questions; research or a long search through a codebase or the web that can run on its own while other work goes on; separate reviews or audits.
- NOT independent: one change in one place; steps where each needs the previous step's result; a small task; a follow-up to earlier work ("now fix that", "yes, do it"); anything that is really one piece of work.
parts: 2 to 6 short imperative lines, one per independent part, each with its own difficulty; [] when the request does not split. Never pad the list.
confidence: how sure you are of your whole answer (0..1).
First say why in one short sentence, then decide. Reply with ONLY a JSON object, no prose, no code fence:
{"why":"<one short sentence>","difficulty":"easy"|"medium"|"hard","confidence":<0..1>,"parts":[{"task":"<short line>","difficulty":"easy"|"medium"|"hard"}]}`;

export function nudgeUserPrompt(prompt, maxChars = 6000) {
  let p = String(prompt ?? '');
  if (p.length > maxChars) p = p.slice(0, maxChars) + '\n[... truncated]';
  return ['Should this request be split across subagents?', 'Request:', '<<<', p, '>>>'].join('\n');
}

export function parseNudge(text, levels) {
  const v = parseVerdict(text, levels);
  if (v.error) return v;
  let raw;
  try { raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).parts; } catch {}
  const parts = (Array.isArray(raw) ? raw : [])
    .map((p) => (typeof p === 'string' ? { task: p } : p))
    .filter((p) => p && typeof p.task === 'string' && p.task.trim())
    .slice(0, 6)
    .map((p) => {
      const d = typeof p.difficulty === 'string' ? p.difficulty.toLowerCase().trim() : '';
      return { task: clip(p.task, 160), difficulty: levels.includes(d) ? d : v.difficulty };
    });
  return { ...v, parts };
}

export function nudgeCacheKey(prompt, cfg) {
  return 'nudge:' + createHash('sha256')
    .update(JSON.stringify([cfg.judgeModel, cfg.judgeApiModel, NUDGE_SYSTEM, nudgeUserPrompt(prompt, cfg.maxPromptChars)]))
    .digest('hex').slice(0, 32);
}

export async function askNudge(prompt, cfg, env = process.env, impl = { api: judgeViaApi, cli: judgeViaCli }) {
  const levels = Object.keys(cfg.routes);
  return askModel(nudgeUserPrompt(prompt, cfg.maxPromptChars), NUDGE_SYSTEM, (text) => parseNudge(text, levels), cfg, env, impl);
}

export async function askNudgeCached(prompt, cfg, env = process.env, judge = askNudge, now = Date.now) {
  return withCache(nudgeCacheKey(prompt, cfg), () => judge(prompt, cfg, env), cfg, env, now);
}

// Prompts Claude Code itself submits, not the user: a subagent's hand-back (<agent-message from=…>), background
// task and shell notifications, a local command's output, reminders. Seen in real runs: each finished background
// subagent's report arrives as a UserPromptSubmit prompt starting with <agent-message.
const MACHINE_PROMPT = /^<(agent-message|[a-z-]*notification|command-(name|message|args)|local-command-[a-z]+|system-reminder|user-prompt-submit-hook)\b/i;

// Why a prompt is not judged at all (cheap checks, nothing logged), or undefined when it is.
export function nudgeSkip(hookInput, cfg, env = process.env) {
  if (env.MODEL_JUDGE_INNER === '1') return 'guard';
  if (String(cfg.delegationNudge ?? 'off').toLowerCase() !== 'on') return 'off';
  const prompt = typeof hookInput?.prompt === 'string' ? hookInput.prompt.trim() : '';
  if (!prompt) return 'empty';
  if (prompt.startsWith('/')) return 'slash-command';
  if (MACHINE_PROMPT.test(prompt)) return 'not-from-user';
  if (prompt.length < (Number(cfg.nudgeMinChars) || 0)) return 'short';
  return undefined;
}

const RANK = { easy: 0, medium: 1, hard: 2 };

// Returns { output, log }: output is the hook's stdout object or null (prompt untouched); log is undefined for
// the cheap skips (off, short, slash command, guard), so a prompt that is never judged leaves no trace.
export async function decideNudge(hookInput, { env = process.env, cfg = loadConfig(env), judge = askNudgeCached } = {}) {
  const skip = nudgeSkip(hookInput, cfg, env);
  if (skip) return { output: null, log: undefined, skip };
  const prompt = hookInput.prompt.trim();
  const log = {
    ts: new Date().toISOString(),
    kind: 'nudge',
    session_id: hookInput.session_id,
    prompt_head: prompt.slice(0, 200),
    prompt_chars: prompt.length,
  };
  const r = await judge(prompt, cfg, env);
  Object.assign(log, { judge: r.judge ?? null, judge_ms: r.ms, ...(r.cachedFrom ? { cached_from: r.cachedFrom } : {}) });
  if (r.error) {
    log.status = 'failed';
    log.reason = `judge failed: ${r.error}`;
  } else {
    const { difficulty, confidence, why, parts = [] } = r.verdict;
    Object.assign(log, { difficulty, confidence, why, parts });
    const minRank = RANK[cfg.nudgeMinDifficulty] ?? RANK.medium;
    const minParts = Math.max(2, Number(cfg.nudgeMinParts) || 2);
    const minConf = Number(cfg.nudgeMinConfidence) || 0;
    if ((RANK[difficulty] ?? -1) < minRank) { log.status = 'none'; log.reason = `${difficulty}: below ${cfg.nudgeMinDifficulty}`; }
    else if (confidence < minConf) { log.status = 'none'; log.reason = `judge unsure: confidence ${confidence} < ${minConf}`; }
    else if (parts.length < minParts) { log.status = 'none'; log.reason = `${parts.length} independent part(s) < ${minParts}`; }
    else log.status = 'nudge';
  }
  let output = null;
  if (log.status === 'nudge') {
    output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: nudgeContext(log, cfg, env) } };
  }
  const message = formatNudgeMessage(log, cfg);
  if (message) output = { ...(output ?? {}), systemMessage: message };
  return { output, log };
}

// The context the main agent gets: the parts, the model and effort model-judge is likely to give each one's
// subagent (the PreToolUse judge decides for real at each spawn), and when not to delegate.
export function nudgeContext(log, cfg = DEFAULT_CONFIG, env = process.env) {
  const allowed = fieldsAllowed(env);
  const lines = log.parts.map((p, i) => {
    const route = cfg.routes[p.difficulty] || {};
    const model = toModelAlias(route.model);
    const effort = cfg.setEffort && allowed.effort ? toEffort(route.effort) : undefined;
    const on = model && allowed.model ? ` → likely ${model}${effort ? ` / ${effort} effort` : ''}` : '';
    return `${i + 1}. ${p.task} (${p.difficulty}${on})`;
  });
  return [
    `model-judge delegation hint (from the model-judge plugin, not from the user): this task looks ${log.difficulty} ` +
      `(confidence ${log.confidence}) and splits into ${log.parts.length} parts that can run independently:`,
    ...lines,
    'Recommended: hand these parts to subagents with the Agent tool, one subagent per part, all in one message so they run ' +
      'in parallel. This is the case the Agent tool is meant for: independent work that can run at the same time, ' +
      'checked by a judge before you start. Each subagent starts with a fresh context, so give it a self-contained prompt with the paths and facts it ' +
      'needs. model-judge sets each subagent\'s model and effort when it starts (the guesses above), so you need not set them. ' +
      'Keep in the main agent any part that is only a quick lookup or a small edit, work that is tightly coupled, and putting ' +
      'the parts\' results together. This is a recommendation, not a requirement: skip it if the split doesn\'t fit what you ' +
      'know of the task.',
  ].join('\n');
}

// The line the user sees: when a nudge is added (display "all" or "changes"), or the judge failed ("all" only).
export function formatNudgeMessage(log, cfg = DEFAULT_CONFIG) {
  const mode = cfg.display ?? 'all';
  if (mode === 'off' || mode === false || !log) return undefined;
  const secs = log.judge === 'cache' ? ', cached' : typeof log.judge_ms === 'number' ? `, ${(log.judge_ms / 1000).toFixed(1)}s` : '';
  if (log.status === 'nudge') {
    return `⚖ model-judge: suggested delegation: ${log.parts.length} parts (${log.difficulty} ${log.confidence.toFixed(2)}${secs})`;
  }
  if (log.status === 'failed' && mode === 'all') {
    return `⚖ model-judge: delegation check failed (${clip(String(log.reason).replace(/^judge failed: /, ''), 80)}) → no hint${secs}`;
  }
  return undefined;
}
