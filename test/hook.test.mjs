// End-to-end tests of the hook process: fixtures on stdin, a fake `claude` as the judge, the log checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = join(HERE, '..', 'scripts', 'route.mjs');
const FAKE = join(HERE, 'fixtures', 'fake-claude.mjs');
chmodSync(FAKE, 0o755);

function fixture(name) { return readFileSync(join(HERE, 'fixtures', `${name}.json`), 'utf8'); }

function baseEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-test-'));
  return {
    dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MODEL_JUDGE_DIR: dir,
      MODEL_JUDGE_CLAUDE_BIN: FAKE,
      FAKE_CLAUDE_RECORD: join(dir, 'calls.jsonl'),
      ...extra,
    },
  };
}

// Run the hook (async variant for tests that need a server in this process).
function runHookAsync(stdin, env) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const t0 = Date.now();
      const c = spawn(process.execPath, [ROUTE], { env });
      let stdout = '', stderr = '';
      c.stdout.on('data', (d) => { stdout += d; });
      c.stderr.on('data', (d) => { stderr += d; });
      c.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0, dir: env.MODEL_JUDGE_DIR }));
      c.stdin.end(stdin);
    });
  });
}

function runHook(stdin, env) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [ROUTE], { input: stdin, env, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0, dir: env.MODEL_JUDGE_DIR };
}

function lastLog(dir) {
  const f = join(dir, 'decisions.jsonl');
  if (!existsSync(f)) return undefined;
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1));
}

// Unchanged: no hookSpecificOutput at all (input and permission untouched), just the line for the user.
function messageOnly(stdout, re) {
  const o = JSON.parse(stdout);
  assert.deepEqual(Object.keys(o), ['systemMessage']);
  assert.match(o.systemMessage, re);
  return o.systemMessage;
}

// apply "spawn" (default): the tool call is left exactly as written (no hookSpecificOutput, so no updatedInput
// and no permission decision: auto mode's review of the call stays valid); the decision is handed off to the
// hooks module in pending/<tool_use_id>.json.
function updated(r, toolUseId = 'toolu_fixture') {
  assert.equal(r.status, 0);
  const o = r.stdout ? JSON.parse(r.stdout) : {};
  assert.equal(o.hookSpecificOutput, undefined, 'the tool call must not be rewritten');
  assert.equal(o.decision, undefined);
  const f = join(r.dir, 'pending', `${toolUseId}.json`);
  assert.ok(existsSync(f), 'decision handed off');
  return JSON.parse(readFileSync(f, 'utf8'));
}

function noHandoff(r, toolUseId = 'toolu_fixture') {
  assert.ok(!existsSync(join(r.dir, 'pending', `${toolUseId}.json`)), 'no decision handed off');
}

test('easy prompt -> haiku + low effort, rest of the input kept', () => {
  const { dir, env } = baseEnv();
  const r = runHook(fixture('easy'), env);
  assert.equal(r.status, 0);
  const u = updated(r);
  assert.equal(u.model, 'haiku');
  assert.equal(u.effort, 'low');
  assert.equal(u.difficulty, 'easy');
  assert.equal(JSON.parse(r.stdout).systemMessage.startsWith('⚖ model-judge: "find a constant" → easy'), true);
  const log = lastLog(dir);
  assert.equal(log.action, 'override');
  assert.equal(log.model_before, null);
  assert.equal(log.model_after, 'haiku');
  assert.equal(log.effort_after, 'low');
  assert.equal(log.difficulty, 'easy');
  assert.equal(log.judge, 'cli');
  assert.equal(log.description, 'find a constant');
  assert.ok(log.prompt_head.startsWith('Find where MAX_RETRIES'));
  assert.ok(log.why);
});

test('override shows the user one line: verdict, model before -> after, effort, judge time', () => {
  const { env } = baseEnv();
  const o = JSON.parse(runHook(fixture('model-set-opus'), env).stdout);
  assert.match(o.systemMessage, /^⚖ model-judge: "trivial but opus requested" → easy 0\.97 · opus→haiku · effort low \(\d+\.\ds\)$/);
  assert.equal(o.hookSpecificOutput, undefined);
});

test('display "off": no message, routing unchanged', () => {
  const { dir, env } = baseEnv();
  const cfg = join(dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ display: 'off' }));
  const r = runHook(fixture('easy'), { ...env, MODEL_JUDGE_CONFIG: cfg });
  assert.equal(r.stdout, '');
  assert.equal(updated(r).model, 'haiku');
  assert.equal(runHook(fixture('unsure'), { ...env, MODEL_JUDGE_CONFIG: cfg }).stdout, '');
});

test('hard prompt -> opus + high effort', () => {
  const { env } = baseEnv();
  const u = updated(runHook(fixture('hard'), env));
  assert.equal(u.model, 'opus');
  assert.equal(u.effort, 'high');
});

test('medium prompt -> sonnet + medium effort', () => {
  const { env } = baseEnv();
  const u = updated(runHook(fixture('medium'), env));
  assert.equal(u.model, 'sonnet');
  assert.equal(u.effort, 'medium');
});

test('model and effort already set by the caller are overridden (opus/max -> haiku/low)', () => {
  const { dir, env } = baseEnv();
  const u = updated(runHook(fixture('model-set-opus'), env));
  assert.equal(u.model, 'haiku');
  assert.equal(u.effort, 'low');
  const log = lastLog(dir);
  assert.equal(log.model_before, 'opus');
  assert.equal(log.effort_before, 'max');
  assert.equal(log.model_after, 'haiku');
});

test('caller asked haiku for a hard task -> overridden to opus', () => {
  const { env } = baseEnv();
  const u = updated(runHook(fixture('model-set-haiku'), env));
  assert.equal(u.model, 'opus');
});

test('legacy tool name Task is handled too', () => {
  const { env } = baseEnv();
  assert.equal(updated(runHook(fixture('task-legacy'), env)).model, 'haiku');
});

test('judge called as claude -p with no tools/MCP/settings, in an empty temp dir, with the recursion guard', () => {
  const { dir, env } = baseEnv();
  runHook(fixture('easy'), env);
  const call = JSON.parse(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim());
  const a = call.args;
  assert.equal(a[a.indexOf('-p')], '-p');
  assert.equal(a[a.indexOf('--model') + 1], 'haiku');
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(a[a.indexOf('--setting-sources') + 1], '');
  assert.ok(a.includes('--no-session-persistence'));
  assert.equal(call.inner, '1');
  assert.match(call.cwd, /task-/);
  assert.ok(!existsSync(call.cwd), 'temp dir removed afterwards');
  assert.match(call.prompt, /Description: find a constant/);
});

test('inside the judge (MODEL_JUDGE_INNER=1): no-op, no judge call', () => {
  const { dir, env } = baseEnv({ MODEL_JUDGE_INNER: '1' });
  const r = runHook(fixture('easy'), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(!existsSync(join(dir, 'calls.jsonl')));
});

test('judge missing (claude not found): unchanged, exit 0, logged', () => {
  const { dir, env } = baseEnv({ MODEL_JUDGE_CLAUDE_BIN: '/nonexistent/claude' });
  const r = runHook(fixture('model-set-opus'), env);
  assert.equal(r.status, 0);
  messageOnly(r.stdout, /model-judge: "trivial but opus requested" judge failed \(cli: .*ENOENT.*\) → left as opus/);
  const log = lastLog(dir);
  assert.equal(log.action, 'unchanged');
  assert.match(log.reason, /judge failed: cli: .*ENOENT/);
  assert.equal(log.model_after, 'opus');
});

test('judge erroring (exit 1): unchanged, exit 0', () => {
  const { dir, env } = baseEnv();
  const r = runHook(fixture('judge-error'), env);
  assert.equal(r.status, 0);
  messageOnly(r.stdout, /judge failed \(cli: claude -p exited 1/);
  assert.match(lastLog(dir).reason, /exited 1/);
});

test('judge answering without JSON: unchanged', () => {
  const { dir, env } = baseEnv();
  const r = runHook(fixture('judge-garbage'), env);
  messageOnly(r.stdout, /judge failed \(cli: judge reply has no JSON object\)/);
  assert.match(lastLog(dir).reason, /no JSON object/);
});

test('judge unsure (confidence 0.4 < 0.75): unchanged, verdict still logged', () => {
  const { dir, env } = baseEnv();
  const r = runHook(fixture('unsure'), env);
  messageOnly(r.stdout, /^⚖ model-judge: "vague task" unsure 0\.40 \(medium\?\) → left as default \(\d+\.\ds\)$/);
  const log = lastLog(dir);
  assert.equal(log.action, 'unchanged');
  assert.equal(log.confidence, 0.4);
  assert.match(log.reason, /unsure/);
});

test('judge too slow: unchanged after the timeout, exit 0', () => {
  const { dir, env } = baseEnv();
  const cfg = join(dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ timeoutMs: 1500 }));
  const r = runHook(fixture('judge-slow'), { ...env, MODEL_JUDGE_CONFIG: cfg });
  assert.equal(r.status, 0);
  messageOnly(r.stdout, /judge failed \(cli: claude -p timed out after \d+ ms\)/);
  assert.ok(r.ms < 4500, `took ${r.ms} ms`);
  assert.match(lastLog(dir).reason, /timed out/);
});

test('fork: left alone (Claude Code ignores model/effort for forks)', () => {
  const { dir, env } = baseEnv();
  messageOnly(runHook(fixture('fork'), env).stdout, /"a fork" skipped \(fork\) → left as default/);
  assert.match(lastLog(dir).reason, /fork/);
});

test('another tool (Bash): left alone', () => {
  const { env } = baseEnv();
  assert.equal(runHook(fixture('not-agent'), env).stdout, '');
});

test('bad stdin: exit 0, no output', () => {
  const { env } = baseEnv();
  const r = runHook('not json', env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('CLAUDE_CODE_EFFORT_LEVEL pins effort: model set, effort not added', () => {
  const { dir, env } = baseEnv({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
  const u = updated(runHook(fixture('easy'), env));
  assert.equal(u.model, 'haiku');
  assert.equal(u.effort, undefined);
  assert.match(lastLog(dir).note, /CLAUDE_CODE_EFFORT_LEVEL/);
});

test('CLAUDE_CODE_SUBAGENT_MODEL_FORCE: the tool has no model field, left alone', () => {
  const { env } = baseEnv({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  messageOnly(runHook(fixture('easy'), env).stdout, /skipped \(CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set\)/);
});

test('config file changes the mapping and the judge model', () => {
  const { dir, env } = baseEnv();
  const cfg = join(dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ judgeModel: 'sonnet', routes: { easy: { model: 'claude-sonnet-5-5', effort: 'medium' } } }));
  const u = updated(runHook(fixture('easy'), { ...env, MODEL_JUDGE_CONFIG: cfg }));
  assert.equal(u.model, 'sonnet');
  assert.equal(u.effort, 'medium');
  const a = JSON.parse(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim()).args;
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
});

// ---- ANTHROPIC_API_KEY path, against a local stand-in for the Messages API ----

function fakeApi(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen.push({ headers: req.headers, url: req.url, body: JSON.parse(body) });
        handler(req, res);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('API key set: judge via the Messages API, claude -p not called', async () => {
  const api = await fakeApi((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text: '{"difficulty":"hard","confidence":0.9,"why":"api says hard"}' }] }));
  });
  try {
    const { dir, env } = baseEnv({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: api.url });
    const r = await runHookAsync(fixture('easy'), env);
    assert.equal(updated(r).model, 'opus');
    assert.equal(lastLog(dir).judge, 'api');
    assert.equal(api.seen[0].url, '/v1/messages');
    assert.equal(api.seen[0].headers['x-api-key'], 'test-key');
    assert.equal(api.seen[0].body.model, 'claude-haiku-5-5');
    assert.ok(!existsSync(join(dir, 'calls.jsonl')));
  } finally { api.srv.close(); }
});

test('API failing: falls back to claude -p', async () => {
  const api = await fakeApi((req, res) => { res.statusCode = 500; res.end('{"error":"boom"}'); });
  try {
    const { dir, env } = baseEnv({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: api.url });
    const r = await runHookAsync(fixture('easy'), env);
    assert.equal(updated(r).model, 'haiku');
    assert.equal(lastLog(dir).judge, 'cli');
    assert.ok(existsSync(join(dir, 'calls.jsonl')));
  } finally { api.srv.close(); }
});

// ---- apply modes, hand-off, cache ----

test('unchanged calls hand nothing off (unsure, judge failed, fork)', () => {
  for (const [name, extra] of [['unsure', {}], ['judge-error', {}], ['fork', {}], ['easy', { MODEL_JUDGE_CLAUDE_BIN: '/nonexistent/claude' }]]) {
    const { env } = baseEnv(extra);
    noHandoff(runHook(fixture(name), env));
  }
});

test('apply "input" (legacy, for Claude Code without hook modules): rewrites the call, no permission decision', () => {
  const { dir, env } = baseEnv();
  const cfg = join(dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ apply: 'input' }));
  const r = runHook(fixture('model-set-opus'), { ...env, MODEL_JUDGE_CONFIG: cfg });
  const o = JSON.parse(r.stdout);
  assert.equal(o.hookSpecificOutput.permissionDecision, undefined);
  const orig = JSON.parse(fixture('model-set-opus')).tool_input;
  assert.deepEqual(o.hookSpecificOutput.updatedInput, { ...orig, model: 'haiku', effort: 'low' });
  assert.match(o.systemMessage, /opus→haiku/);
  noHandoff(r);
  assert.equal(lastLog(dir).apply, 'input');
});

test('the same call judged again within the TTL reuses the verdict: one judge call', () => {
  const { dir, env } = baseEnv();
  const a = runHook(fixture('hard'), env);
  const b = runHook(fixture('hard'), env);
  assert.equal(updated(a).model, 'opus');
  assert.equal(updated(b).model, 'opus');
  const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 1, 'judge called once');
  const log = lastLog(dir);
  assert.equal(log.judge, 'cache');
  assert.equal(log.cached_from, 'cli');
  assert.equal(log.judge_ms, 0);
  assert.match(JSON.parse(b.stdout).systemMessage, /\(0\.0s\)$/);
});

test('a different prompt is not served from the cache; cacheTtlMs 0 turns the cache off', () => {
  const { dir, env } = baseEnv();
  runHook(fixture('hard'), env);
  runHook(fixture('easy'), env);
  assert.equal(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').length, 2);
  const off = baseEnv();
  const cfg = join(off.dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ cacheTtlMs: 0 }));
  runHook(fixture('hard'), { ...off.env, MODEL_JUDGE_CONFIG: cfg });
  runHook(fixture('hard'), { ...off.env, MODEL_JUDGE_CONFIG: cfg });
  assert.equal(readFileSync(join(off.dir, 'calls.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('failed judge calls are not cached', () => {
  const { dir, env } = baseEnv();
  runHook(fixture('judge-error'), env);
  runHook(fixture('judge-error'), env);
  assert.equal(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').length, 2);
});

// ---- scripts/spawn.mjs, the hooks module's helper ----

const SPAWN = join(HERE, '..', 'scripts', 'spawn.mjs');
const helper = (cmd, payload, env) => spawnSync(process.execPath, [SPAWN, cmd], { input: JSON.stringify(payload), env, encoding: 'utf8' });

test('spawn.mjs take: returns the hand-off once, then {}', () => {
  const { env } = baseEnv();
  runHook(fixture('easy'), env);
  const first = JSON.parse(helper('take', { tool_use_id: 'toolu_fixture' }, env).stdout);
  assert.equal(first.model, 'haiku');
  assert.equal(first.effort, 'low');
  assert.deepEqual(JSON.parse(helper('take', { tool_use_id: 'toolu_fixture' }, env).stdout), {});
  assert.deepEqual(JSON.parse(helper('take', { tool_use_id: '../../etc/passwd' }, env).stdout), {});
  assert.deepEqual(JSON.parse(helper('take', {}, env).stdout), {});
});

test('spawn.mjs applied: logs an "applied" line; bad input still exits 0 with {}', () => {
  const { dir, env } = baseEnv();
  helper('applied', { tool_use_id: 'toolu_x', agentId: 'a1', model: 'claude-haiku-5-5', effort: 'low', session_id: 's' }, env);
  const log = lastLog(dir);
  assert.equal(log.event, 'applied');
  assert.equal(log.agent_id, 'a1');
  assert.equal(log.model, 'claude-haiku-5-5');
  const r = spawnSync(process.execPath, [SPAWN, 'take'], { input: 'not json', env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}');
});
