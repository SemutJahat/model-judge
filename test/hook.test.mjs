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
      JUDGE_ROUTER_DIR: dir,
      JUDGE_ROUTER_CLAUDE_BIN: FAKE,
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
      c.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
      c.stdin.end(stdin);
    });
  });
}

function runHook(stdin, env) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [ROUTE], { input: stdin, env, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

function lastLog(dir) {
  const f = join(dir, 'decisions.jsonl');
  if (!existsSync(f)) return undefined;
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1));
}

function updated(stdout) {
  const o = JSON.parse(stdout);
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(o.hookSpecificOutput.permissionDecision, undefined, 'permission decision must stay neutral');
  assert.equal(o.decision, undefined);
  return o.hookSpecificOutput.updatedInput;
}

test('easy prompt -> haiku + low effort, rest of the input kept', () => {
  const { dir, env } = baseEnv();
  const r = runHook(fixture('easy'), env);
  assert.equal(r.status, 0);
  const u = updated(r.stdout);
  const orig = JSON.parse(fixture('easy')).tool_input;
  assert.deepEqual(u, { ...orig, model: 'haiku', effort: 'low' });
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

test('hard prompt -> opus + high effort', () => {
  const { env } = baseEnv();
  const u = updated(runHook(fixture('hard'), env).stdout);
  assert.equal(u.model, 'opus');
  assert.equal(u.effort, 'high');
});

test('medium prompt -> sonnet + medium effort', () => {
  const { env } = baseEnv();
  const u = updated(runHook(fixture('medium'), env).stdout);
  assert.equal(u.model, 'sonnet');
  assert.equal(u.effort, 'medium');
});

test('model and effort already set by the caller are overridden (opus/max -> haiku/low)', () => {
  const { dir, env } = baseEnv();
  const u = updated(runHook(fixture('model-set-opus'), env).stdout);
  assert.equal(u.model, 'haiku');
  assert.equal(u.effort, 'low');
  const log = lastLog(dir);
  assert.equal(log.model_before, 'opus');
  assert.equal(log.effort_before, 'max');
  assert.equal(log.model_after, 'haiku');
});

test('caller asked haiku for a hard task -> overridden to opus', () => {
  const { env } = baseEnv();
  const u = updated(runHook(fixture('model-set-haiku'), env).stdout);
  assert.equal(u.model, 'opus');
});

test('legacy tool name Task is handled too', () => {
  const { env } = baseEnv();
  assert.equal(updated(runHook(fixture('task-legacy'), env).stdout).model, 'haiku');
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

test('inside the judge (JUDGE_ROUTER_INNER=1): no-op, no judge call', () => {
  const { dir, env } = baseEnv({ JUDGE_ROUTER_INNER: '1' });
  const r = runHook(fixture('easy'), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(!existsSync(join(dir, 'calls.jsonl')));
});

test('judge missing (claude not found): unchanged, exit 0, logged', () => {
  const { dir, env } = baseEnv({ JUDGE_ROUTER_CLAUDE_BIN: '/nonexistent/claude' });
  const r = runHook(fixture('model-set-opus'), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const log = lastLog(dir);
  assert.equal(log.action, 'unchanged');
  assert.match(log.reason, /judge failed: cli: .*ENOENT/);
  assert.equal(log.model_after, 'opus');
});

test('judge erroring (exit 1): unchanged, exit 0', () => {
  const { dir, env } = baseEnv();
  const r = runHook(fixture('judge-error'), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(lastLog(dir).reason, /exited 1/);
});

test('judge answering without JSON: unchanged', () => {
  const { dir, env } = baseEnv();
  const r = runHook(fixture('judge-garbage'), env);
  assert.equal(r.stdout, '');
  assert.match(lastLog(dir).reason, /no JSON object/);
});

test('judge unsure (confidence 0.4 < 0.75): unchanged, verdict still logged', () => {
  const { dir, env } = baseEnv();
  const r = runHook(fixture('unsure'), env);
  assert.equal(r.stdout, '');
  const log = lastLog(dir);
  assert.equal(log.action, 'unchanged');
  assert.equal(log.confidence, 0.4);
  assert.match(log.reason, /unsure/);
});

test('judge too slow: unchanged after the timeout, exit 0', () => {
  const { dir, env } = baseEnv();
  const cfg = join(dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ timeoutMs: 1500 }));
  const r = runHook(fixture('judge-slow'), { ...env, JUDGE_ROUTER_CONFIG: cfg });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms < 4500, `took ${r.ms} ms`);
  assert.match(lastLog(dir).reason, /timed out/);
});

test('fork: left alone (Claude Code ignores model/effort for forks)', () => {
  const { dir, env } = baseEnv();
  assert.equal(runHook(fixture('fork'), env).stdout, '');
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
  const u = updated(runHook(fixture('easy'), env).stdout);
  assert.equal(u.model, 'haiku');
  assert.equal(u.effort, undefined);
  assert.match(lastLog(dir).note, /CLAUDE_CODE_EFFORT_LEVEL/);
});

test('CLAUDE_CODE_SUBAGENT_MODEL_FORCE: the tool has no model field, left alone', () => {
  const { env } = baseEnv({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  assert.equal(runHook(fixture('easy'), env).stdout, '');
});

test('config file changes the mapping and the judge model', () => {
  const { dir, env } = baseEnv();
  const cfg = join(dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ judgeModel: 'sonnet', routes: { easy: { model: 'claude-sonnet-5-5', effort: 'medium' } } }));
  const u = updated(runHook(fixture('easy'), { ...env, JUDGE_ROUTER_CONFIG: cfg }).stdout);
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
    assert.equal(updated(r.stdout).model, 'opus');
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
    assert.equal(updated(r.stdout).model, 'haiku');
    assert.equal(lastLog(dir).judge, 'cli');
    assert.ok(existsSync(join(dir, 'calls.jsonl')));
  } finally { api.srv.close(); }
});
