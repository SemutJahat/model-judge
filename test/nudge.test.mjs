// The opt-in delegation nudge (UserPromptSubmit, scripts/nudge.mjs): the hook process end to end with the fake
// `claude` as the judge, and the pure parts of lib.mjs with a stubbed judge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG, loadConfig, parseNudge, nudgeSkip, decideNudge, askNudge, askNudgeCached, nudgeCacheKey,
  nudgeContext, formatNudgeMessage, NUDGE_SYSTEM,
} from '../scripts/lib.mjs';
import { lastDecision } from '../scripts/statusline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NUDGE = join(HERE, '..', 'scripts', 'nudge.mjs');
const LOG = join(HERE, '..', 'scripts', 'log.mjs');
const FAKE = join(HERE, 'fixtures', 'fake-claude.mjs');
chmodSync(FAKE, 0o755);
const LEVELS = ['easy', 'medium', 'hard'];
const LONG = ' and then do the rest of what this long enough prompt asks for, carefully, across the codebase.';
const ON = { ...DEFAULT_CONFIG, delegationNudge: 'on' };

// A temp data dir standing in for ~/.claude/model-judge (its config.json is the personal override).
function setup({ personal, extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mj-nudge-'));
  if (personal !== undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify(personal));
  return {
    dir,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC',
      MODEL_JUDGE_DIR: dir, MODEL_JUDGE_CLAUDE_BIN: FAKE, FAKE_CLAUDE_RECORD: join(dir, 'calls.jsonl'), ...extra,
    },
  };
}
const hookInput = (prompt) => JSON.stringify({ session_id: 'sess-n', hook_event_name: 'UserPromptSubmit', prompt, cwd: '/x' });
const runNudge = (prompt, env, raw) => spawnSync(process.execPath, [NUDGE], { input: raw ?? hookInput(prompt), env, encoding: 'utf8', timeout: 30000 });
const logLines = (dir) => existsSync(join(dir, 'decisions.jsonl'))
  ? readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const judgeCalls = (dir) => existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').length : 0;

// ---- the hook process --------------------------------------------------------------------------

test('off by default: no judge call, no output, nothing logged', () => {
  const { dir, env } = setup();
  assert.equal(loadConfig(env).delegationNudge, 'off', 'the shipped config.json keeps it off');
  const r = runNudge('SPLIT: add an endpoint, count TODOs and design a cache' + LONG, env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(judgeCalls(dir), 0);
  assert.deepEqual(logLines(dir), []);
});

test('on (personal ~/.claude/model-judge/config.json) + multi-part prompt: context for the agent, one line for the user, logged', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on' } });
  const r = runNudge('SPLIT: add an endpoint, count TODOs and design a cache' + LONG, env);
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout);
  assert.match(o.systemMessage, /^⚖ model-judge: suggested delegation: 3 parts \(hard 0\.86, \d+\.\ds\)$/);
  assert.equal(o.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = o.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^model-judge delegation hint \(from the model-judge plugin, not from the user\): this task looks hard \(confidence 0\.86\) and splits into 3 parts/);
  assert.match(ctx, /1\. Add the \/export endpoint in server\/ \(medium → likely sonnet \/ medium effort\)/);
  assert.match(ctx, /2\. Count the TODOs in docs\/ \(easy → likely haiku \/ low effort\)/);
  assert.match(ctx, /3\. Design the cache invalidation scheme \(hard → likely opus \/ high effort\)/);
  assert.match(ctx, /Recommended: hand these parts to subagents with the Agent tool, one subagent per part, all in one message/);
  assert.match(ctx, /Keep in the main agent any part that is only a quick lookup or a small edit, work that is tightly coupled/);
  assert.match(ctx, /This is a recommendation, not a requirement/);
  assert.equal(o.decision, undefined, 'never blocks the prompt');
  const [log] = logLines(dir);
  assert.equal(log.kind, 'nudge');
  assert.equal(log.status, 'nudge');
  assert.equal(log.session_id, 'sess-n');
  assert.equal(log.difficulty, 'hard');
  assert.equal(log.parts.length, 3);
  assert.equal(log.judge, 'cli');
  // the judge ran as the subagent judge does: no tools, no settings, recursion guard, its own system prompt
  const call = JSON.parse(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim());
  assert.equal(call.inner, '1');
  assert.equal(call.args[call.args.indexOf('--system-prompt') + 1], NUDGE_SYSTEM);
  assert.ok(call.args.includes('--setting-sources'));
  assert.match(call.prompt, /SPLIT: add an endpoint/);
});

test('on + easy prompt: nothing added, nothing shown, logged as no nudge', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on' } });
  const r = runNudge('What does the confidenceThreshold setting do in this plugin, and what is its default value here?', env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const [log] = logLines(dir);
  assert.equal(log.status, 'none');
  assert.match(log.reason, /easy: below medium/);
});

test('on + hard but tightly coupled (no independent parts): nothing added', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on' } });
  assert.equal(runNudge('COUPLED: refactor the scheduler core' + LONG, env).stdout, '');
  assert.match(logLines(dir)[0].reason, /0 independent part\(s\) < 2/);
});

test('on + judge unsure: nothing added', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on' } });
  assert.equal(runNudge('UNSURE: look into it' + LONG, env).stdout, '');
  assert.match(logLines(dir)[0].reason, /judge unsure: confidence 0\.4 < 0\.7/);
});

test('cheap skips: short prompt, slash command, subagent hand-back, inside the judge: no judge call, nothing logged', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on' } });
  assert.equal(runNudge('SPLIT: yes do it', env).stdout, '');
  assert.equal(runNudge('/model-judge:log 20 SPLIT:' + LONG, env).stdout, '');
  assert.equal(runNudge('SPLIT: x' + LONG, { ...env, MODEL_JUDGE_INNER: '1' }).stdout, '');
  assert.equal(runNudge('<agent-message from="a1">\n[Subagent hand-back] SPLIT:' + LONG, env).stdout, '');
  assert.equal(runNudge('', env, 'not json').stdout, '');
  assert.equal(judgeCalls(dir), 0);
  assert.deepEqual(logLines(dir), []);
});

test('nudgeMinChars is configurable', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on', nudgeMinChars: 10 } });
  assert.match(JSON.parse(runNudge('SPLIT: three things', env).stdout).systemMessage, /3 parts/);
  assert.equal(judgeCalls(dir), 1);
});

test('the same prompt again is served from the cache: no second judge call', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on' } });
  const p = 'SPLIT: add an endpoint, count TODOs and design a cache' + LONG;
  runNudge(p, env);
  const o = JSON.parse(runNudge(p, env).stdout);
  assert.match(o.systemMessage, /3 parts \(hard 0\.86, cached\)/);
  assert.equal(judgeCalls(dir), 1);
  assert.equal(logLines(dir)[1].judge, 'cache');
});

test('judge fails: fails open (exit 0, prompt untouched), "all" shows why, "changes" stays quiet', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on' } });
  const r = runNudge('ERROR: whatever' + LONG, env);
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(o), ['systemMessage']);
  assert.match(o.systemMessage, /^⚖ model-judge: delegation check failed \(cli: claude -p exited 1/);
  assert.equal(logLines(dir)[0].status, 'failed');
  const quiet = setup({ personal: { delegationNudge: 'on', display: 'changes' } });
  assert.equal(runNudge('ERROR: whatever' + LONG, quiet.env).stdout, '');
});

test('judge too slow: killed at timeoutMs, prompt untouched', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on', timeoutMs: 1500 } });
  const t0 = Date.now();
  const r = runNudge('SLOW: ' + LONG, env);
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 < 4500, 'did not wait for the 5 s judge');
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput, undefined);
  assert.match(logLines(dir)[0].reason, /timed out/);
});

test('judge missing: prompt untouched', () => {
  const { env } = setup({ personal: { delegationNudge: 'on' } });
  const r = runNudge('SPLIT: x' + LONG, { ...env, MODEL_JUDGE_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput, undefined);
});

test('display "off": the context still goes to the agent, no line for the user', () => {
  const { env } = setup({ personal: { delegationNudge: 'on', display: 'off' } });
  const o = JSON.parse(runNudge('SPLIT: x' + LONG, env).stdout);
  assert.equal(o.systemMessage, undefined);
  assert.match(o.hookSpecificOutput.additionalContext, /3 parts/);
});

test('log.mjs shows nudges next to subagent decisions; the status line ignores them', () => {
  const { dir, env } = setup({ personal: { delegationNudge: 'on' } });
  runNudge('SPLIT: add an endpoint, count TODOs and design a cache' + LONG, env);
  runNudge('What does the confidenceThreshold setting do in this plugin, and what is its default value here?', env);
  const t = spawnSync(process.execPath, [LOG], { env, encoding: 'utf8' }).stdout;
  assert.match(t, /prompt: SPLIT: add an endpo…\s+hard\s+0\.86\s+3 parts\s+-\s+\d+\.\ds\s+nudge/);
  assert.match(t, /prompt: What does the confi…\s+easy\s+0\.95\s+0 parts\s+-\s+\d+\.\ds\s+no-nudge/);
  assert.equal(lastDecision(join(dir, 'decisions.jsonl'), 'sess-n'), undefined);
});

// ---- the pure parts --------------------------------------------------------------------------

test('parseNudge: parts checked, capped at 6, clipped; a part without a difficulty takes the overall one', () => {
  const v = parseNudge(JSON.stringify({ difficulty: 'hard', confidence: 0.8, why: 'w',
    parts: ['plain string', { task: 'x'.repeat(300), difficulty: 'EASY' }, { task: '' }, { nope: 1 }, 'a', 'b', 'c', 'd', 'e'] }), LEVELS);
  assert.equal(v.parts.length, 6);
  assert.deepEqual(v.parts[0], { task: 'plain string', difficulty: 'hard' });
  assert.equal(v.parts[1].difficulty, 'easy');
  assert.equal(v.parts[1].task.length, 160);
  assert.deepEqual(parseNudge('{"difficulty":"medium","confidence":0.9}', LEVELS).parts, []);
  assert.match(parseNudge('no json', LEVELS).error, /no JSON/);
});

test('nudgeSkip: off / guard / empty / slash / not from the user / short, else judged', () => {
  assert.equal(nudgeSkip({ prompt: 'x'.repeat(200) }, DEFAULT_CONFIG, {}), 'off');
  assert.equal(nudgeSkip({ prompt: 'x'.repeat(200) }, { ...ON, delegationNudge: 'ON' }, {}), undefined);
  assert.equal(nudgeSkip({ prompt: 'x'.repeat(200) }, ON, { MODEL_JUDGE_INNER: '1' }), 'guard');
  assert.equal(nudgeSkip({ prompt: '   ' }, ON, {}), 'empty');
  assert.equal(nudgeSkip({}, ON, {}), 'empty');
  assert.equal(nudgeSkip({ prompt: '  /compact ' + 'x'.repeat(200) }, ON, {}), 'slash-command');
  for (const p of ['<agent-message from="a322df518236a1865">\n[Subagent hand-back] The text below is the final report',
    '<task-notification>\n<task-id>b1</task-id>', '<bash-notification>done</bash-notification>',
    '<local-command-stdout>ok</local-command-stdout>', '<command-name>/model</command-name>', '<system-reminder>x</system-reminder>']) {
    assert.equal(nudgeSkip({ prompt: p + ' ' + 'x'.repeat(200) }, ON, {}), 'not-from-user', p);
  }
  assert.equal(nudgeSkip({ prompt: '<div> in my page does not center, and also the footer overlaps the sidebar on mobile, fix both please' }, ON, {}), undefined);
  assert.equal(nudgeSkip({ prompt: 'x'.repeat(79) }, ON, {}), 'short');
  assert.equal(nudgeSkip({ prompt: 'x'.repeat(80) }, ON, {}), undefined);
});

test('decideNudge thresholds: difficulty, confidence, parts', async () => {
  const parts = [{ task: 'a', difficulty: 'easy' }, { task: 'b', difficulty: 'medium' }];
  const go = (verdict, cfg = ON) => decideNudge({ prompt: 'x'.repeat(100) }, { env: {}, cfg, judge: async () => ({ verdict, judge: 'stub', ms: 5 }) });
  assert.equal((await go({ difficulty: 'medium', confidence: 0.7, why: '', parts })).log.status, 'nudge');
  assert.equal((await go({ difficulty: 'medium', confidence: 0.69, why: '', parts })).log.status, 'none');
  assert.equal((await go({ difficulty: 'easy', confidence: 0.99, why: '', parts })).log.status, 'none');
  assert.equal((await go({ difficulty: 'hard', confidence: 0.99, why: '', parts: parts.slice(0, 1) })).log.status, 'none');
  assert.equal((await go({ difficulty: 'medium', confidence: 0.9, why: '', parts }, { ...ON, nudgeMinDifficulty: 'hard' })).log.status, 'none');
  assert.equal((await go({ difficulty: 'hard', confidence: 0.9, why: '', parts }, { ...ON, nudgeMinParts: 3 })).log.status, 'none');
  const r = await go({ difficulty: 'hard', confidence: 0.9, why: '', parts });
  assert.equal(r.output.systemMessage, '⚖ model-judge: suggested delegation: 2 parts (hard 0.90, 0.0s)');
});

test('nudgeContext follows the routes, setEffort and the env vars that pin model or effort', () => {
  const log = { difficulty: 'hard', confidence: 0.9, parts: [{ task: 'design it', difficulty: 'hard' }, { task: 'grep it', difficulty: 'easy' }] };
  assert.match(nudgeContext(log, ON, {}), /1\. design it \(hard → likely opus \/ high effort\)\n2\. grep it \(easy → likely haiku \/ low effort\)/);
  assert.match(nudgeContext(log, { ...ON, setEffort: false }, {}), /1\. design it \(hard → likely opus\)\n/);
  assert.match(nudgeContext(log, ON, { CLAUDE_CODE_EFFORT_LEVEL: 'max' }), /1\. design it \(hard → likely opus\)\n/);
  assert.match(nudgeContext(log, ON, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }), /1\. design it \(hard\)\n/);
  assert.match(nudgeContext(log, { ...ON, routes: { ...ON.routes, hard: { model: 'fable', effort: 'max' } } }, {}), /likely fable \/ max effort/);
});

test('formatNudgeMessage: display modes', () => {
  const nudge = { status: 'nudge', parts: [1, 2, 3], difficulty: 'hard', confidence: 0.86, judge: 'cli', judge_ms: 2900 };
  assert.equal(formatNudgeMessage(nudge, ON), '⚖ model-judge: suggested delegation: 3 parts (hard 0.86, 2.9s)');
  assert.equal(formatNudgeMessage(nudge, { ...ON, display: 'changes' }), '⚖ model-judge: suggested delegation: 3 parts (hard 0.86, 2.9s)');
  assert.equal(formatNudgeMessage(nudge, { ...ON, display: 'off' }), undefined);
  assert.equal(formatNudgeMessage({ status: 'none' }, ON), undefined);
  assert.equal(formatNudgeMessage(undefined, ON), undefined);
});

test('askNudge: API first when a key is set, falling back to claude -p; same parser', async () => {
  const reply = JSON.stringify({ difficulty: 'hard', confidence: 0.9, why: 'w', parts: [{ task: 'a' }, { task: 'b' }] });
  const seen = [];
  const r = await askNudge('do things', ON, { ANTHROPIC_API_KEY: 'k' }, {
    api: async (_u, _c, _e, _t, system) => { seen.push(['api', system === NUDGE_SYSTEM]); throw new Error('API 529'); },
    cli: async (u, _c, _e, _t, system) => { seen.push(['cli', system === NUDGE_SYSTEM, u.includes('do things')]); return reply; },
  });
  assert.deepEqual(seen, [['api', true], ['cli', true, true]]);
  assert.equal(r.judge, 'cli');
  assert.equal(r.verdict.parts.length, 2);
});

test('the nudge cache key differs from the subagent one and covers the prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mj-nudge-cache-'));
  assert.match(nudgeCacheKey('a', ON), /^nudge:/);
  assert.notEqual(nudgeCacheKey('a', ON), nudgeCacheKey('b', ON));
  let calls = 0;
  const judge = async () => { calls++; return { verdict: { difficulty: 'hard', confidence: 0.9, why: '', parts: [] }, judge: 'cli', ms: 3 }; };
  const env = { MODEL_JUDGE_DIR: dir };
  let t = 1000;
  await askNudgeCached('p', ON, env, judge, () => t);
  assert.equal((await askNudgeCached('p', ON, env, judge, () => t)).judge, 'cache');
  t += ON.cacheTtlMs + 1;
  assert.equal((await askNudgeCached('p', ON, env, judge, () => t)).judge, 'cli');
  assert.equal(calls, 2);
});
