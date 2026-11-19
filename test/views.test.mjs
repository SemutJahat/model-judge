// The views of the log: the status line text and the log table (scripts/statusline.mjs, scripts/log.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusText, lastDecision } from '../scripts/statusline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');
const dir = mkdtempSync(join(tmpdir(), 'jr-views-'));
copyFileSync(join(HERE, 'fixtures', 'decisions.jsonl'), join(dir, 'decisions.jsonl'));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, MODEL_JUDGE_DIR: dir, TZ: 'UTC' };
const run = (script, args = [], input = '') =>
  spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { env, input, encoding: 'utf8' });

test('statusText: override, unsure, failed, skipped, none', () => {
  assert.equal(statusText({ action: 'override', model_after: 'opus', effort_after: 'high', difficulty: 'hard', confidence: 0.85, description: 'rate limiter design' }),
    '⚖ opus/high · hard 0.85 · "rate limiter design"');
  assert.equal(statusText({ action: 'unchanged', status: 'unsure', model_before: 'sonnet', confidence: 0.4, description: 'vague task' }),
    '⚖ sonnet (unsure 0.40) · "vague task"');
  assert.equal(statusText({ action: 'unchanged', status: 'failed', model_before: null }), '⚖ default (judge failed)');
  assert.equal(statusText({ action: 'unchanged', status: 'skipped', model_before: null, description: 'a fork' }), '⚖ default (skipped) · "a fork"');
  assert.equal(statusText({ action: 'override', model_after: 'haiku', effort_after: null, difficulty: 'easy', confidence: 1, description: 'a very long subagent description here' }),
    '⚖ haiku · easy 1.00 · "a very long subagent de…"');
  assert.equal(statusText(undefined), '');
});

test('lastDecision: the latest of the session, skipping guard lines and bad lines', () => {
  const f = join(dir, 'decisions.jsonl');
  assert.equal(lastDecision(f, 'S1').description, 'vague task');
  assert.equal(lastDecision(f, 'S2').description, 'rate limiter design');
  assert.equal(lastDecision(f, 'nope'), undefined);
  assert.equal(lastDecision(join(dir, 'missing.jsonl'), 'S1'), undefined);
});

test('statusline.mjs reads the session from stdin; prints nothing for an unknown session', () => {
  assert.equal(run('statusline.mjs', [], '{"session_id":"S2"}').stdout, '⚖ opus/high · hard 0.85 · "rate limiter design"');
  assert.equal(run('statusline.mjs', [], '{"session_id":"other"}').stdout, '');
  assert.equal(run('statusline.mjs', [], 'garbage').status, 0);
});

test('log.mjs: compact table of the last N, guard lines hidden', () => {
  const r = run('log.mjs', ['2']);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^time\s+subagent\s+verdict\s+conf\s+model\s+effort\s+judge\s+result$/);
  assert.match(lines[2], /^15:44:08  vague task\s+easy\s+0\.40  sonnet→sonnet\s+-\s+3\.5s\s+unsure$/);
  assert.match(lines[3], /^15:44:09  rate limiter design\s+hard\s+0\.85  default→opus\s+-→high\s+4\.3s\s+override$/);
  assert.match(lines[4], /^\(2 of 3, from /);
});

test('log.mjs: --session filter and --json', () => {
  const r = run('log.mjs', ['--session', 'S1', '--json']);
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => x.description), ['count words', 'vague task']);
});

test('log.mjs: empty log says so', () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'log.mjs')], { env: { ...env, MODEL_JUDGE_DIR: mkdtempSync(join(tmpdir(), 'jr-empty-')) }, encoding: 'utf8' });
  assert.match(r.stdout, /^no decisions yet in /);
});

test('log.mjs: a spawn-mode decision is "override" once the module logged it applied, "pending" before', () => {
  const d = mkdtempSync(join(tmpdir(), 'jr-applied-'));
  const base = { ts: '2026-11-19T15:44:07.000Z', session_id: 'S', tool: 'Agent', model_before: 'sonnet', effort_before: null,
    judge_ms: 3000, difficulty: 'easy', confidence: 0.9, action: 'override', status: 'override', apply: 'spawn', model_after: 'haiku', effort_after: 'low' };
  writeFileSync(join(d, 'decisions.jsonl'), [
    { ...base, tool_use_id: 'a', description: 'applied one' },
    { ts: base.ts, event: 'applied', tool_use_id: 'a', agent_id: 'x', model: 'claude-haiku-5-5', effort: 'low' },
    { ...base, tool_use_id: 'b', description: 'pending one' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'log.mjs')], { env: { ...env, MODEL_JUDGE_DIR: d }, encoding: 'utf8' });
  const rows = r.stdout.trim().split('\n');
  assert.match(rows[2], /applied one .* override$/);
  assert.match(rows[3], /pending one .* pending$/);
  assert.match(rows[4], /^\(2 of 2,/);
  assert.equal(statusText(lastDecision(join(d, 'decisions.jsonl'), 'S')), '⚖ haiku/low · easy 0.90 · "pending one"');
});

test('statusline-launcher: finds the installed copy from installed_plugins.json, prefers semutjahat, runs it', async () => {
  const { findRoot } = await import('../scripts/statusline-launcher.mjs');
  const cfgDir = mkdtempSync(join(tmpdir(), 'jr-cfg-'));
  mkdirSync(join(cfgDir, 'plugins'), { recursive: true });
  const root = join(HERE, '..');
  writeFileSync(join(cfgDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'model-judge@other': [{ scope: 'user', installPath: '/nonexistent' }],
    'model-judge@semutjahat': [{ scope: 'project', installPath: '/nope' }, { scope: 'user', installPath: root }],
  } }));
  assert.equal(findRoot({ CLAUDE_CONFIG_DIR: cfgDir }), root);
  assert.equal(findRoot({ CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'jr-none-')) }), undefined);
  assert.equal(findRoot({ MODEL_JUDGE_ROOT: '/x' }), '/x');
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'statusline-launcher.mjs')],
    { env: { ...env, CLAUDE_CONFIG_DIR: cfgDir }, input: '{"session_id":"S2"}', encoding: 'utf8' });
  assert.equal(r.stdout, '⚖ opus/high · hard 0.85 · "rate limiter design"');
  const none = spawnSync(process.execPath, [join(SCRIPTS, 'statusline-launcher.mjs')],
    { env: { ...env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'jr-none-')) }, input: '{}', encoding: 'utf8' });
  assert.equal(none.status, 0);
  assert.equal(none.stdout, '');
});
