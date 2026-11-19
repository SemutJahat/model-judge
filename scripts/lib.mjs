// judge-router: the logic of the PreToolUse hook, kept free of process I/O so tests can drive it.
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
  routes: {
    easy: { model: 'haiku', effort: 'low' },
    medium: { model: 'sonnet', effort: 'medium' },
    hard: { model: 'opus', effort: 'high' },
  },
};

export function dataDir(env = process.env) {
  return env.JUDGE_ROUTER_DIR || join(homedir(), '.claude', 'judge-router');
}

// Config: the plugin's config.json, then ~/.claude/judge-router/config.json (survives reinstalls),
// then the file named by JUDGE_ROUTER_CONFIG. Later ones win, key by key (routes merged per level).
export function loadConfig(env = process.env) {
  let cfg = structuredClone(DEFAULT_CONFIG);
  const files = [join(PLUGIN_ROOT, 'config.json'), join(dataDir(env), 'config.json')];
  if (env.JUDGE_ROUTER_CONFIG) files.push(env.JUDGE_ROUTER_CONFIG);
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      cfg = { ...cfg, ...c, routes: { ...cfg.routes, ...(c.routes || {}) } };
    } catch { /* a broken config file is ignored, never fatal */ }
  }
  if (env.JUDGE_ROUTER_CLAUDE_BIN) cfg.claudeBin = env.JUDGE_ROUTER_CLAUDE_BIN;
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

async function judgeViaApi(userPrompt, cfg, env, timeoutMs) {
  const res = await fetch((env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.judgeApiModel,
      max_tokens: 300,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// `claude -p` on the user's own login: no tools, no MCP, no settings (so no plugins, so not this hook),
// no session saved, in an empty temp folder (a neutral name: the model sees its working folder), with JUDGE_ROUTER_INNER=1 as a second guard against recursion.
export function judgeViaCli(userPrompt, cfg, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'task-'));
    const args = [
      '-p', '--model', cfg.judgeModel,
      '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--no-session-persistence', '--disable-slash-commands',
      '--output-format', 'json', '--system-prompt', JUDGE_SYSTEM,
    ];
    let out = '', err = '', done = false;
    const child = spawn(cfg.claudeBin, args, {
      cwd,
      env: { ...env, JUDGE_ROUTER_INNER: '1' },
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
  const t0 = Date.now();
  const deadline = t0 + cfg.timeoutMs;
  const userPrompt = judgeUserPrompt(input, cfg.maxPromptChars);
  const levels = Object.keys(cfg.routes);
  const errors = [];
  const tries = [];
  if (cfg.useApiKey && env.ANTHROPIC_API_KEY) tries.push('api');
  tries.push('cli');
  for (const kind of tries) {
    const left = deadline - Date.now();
    if (left < 500) { errors.push(`${kind}: no time left`); break; }
    try {
      const text = await impl[kind](userPrompt, cfg, env, left);
      const v = parseVerdict(text, levels);
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
  const ttl = Number(cfg.cacheTtlMs) || 0;
  if (ttl <= 0) return judge(input, cfg, env);
  const key = cacheKey(input, cfg);
  const hit = readCache(env)[key];
  if (hit && now() - hit.at < ttl && hit.verdict) return { verdict: hit.verdict, judge: 'cache', ms: 0, cachedFrom: hit.judge };
  const r = await judge(input, cfg, env);
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

  if (env.JUDGE_ROUTER_INNER === '1') return unchanged('inside the judge itself (recursion guard)', {}, 'guard');
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
    return `⚖ judge-router: ${name} → ${log.difficulty} ${conf} · ${before}→${log.model_after}${effort}${secs}`;
  }
  if (log.status === 'unsure') {
    if (mode === 'changes') return undefined;
    return `⚖ judge-router: ${name} unsure ${conf} (${log.difficulty}?) → left as ${before}${secs}`;
  }
  if (log.status === 'failed') {
    return `⚖ judge-router: ${name} judge failed (${clip(String(log.reason).replace(/^judge failed: /, ''), 80)}) → left as ${before}${secs}`;
  }
  if (mode === 'changes') return undefined;
  return `⚖ judge-router: ${name} skipped (${clip(String(log.reason).split(':')[0], 60)}) → left as ${before}`;
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
