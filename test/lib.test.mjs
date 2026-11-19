// Unit tests of the pure parts of lib.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, toModelAlias, toEffort, fieldsAllowed, decide, DEFAULT_CONFIG, askJudge, formatMessage } from '../scripts/lib.mjs';

const LEVELS = ['easy', 'medium', 'hard'];
const input = (extra = {}) => ({ tool_name: 'Agent', tool_input: { description: 'd', prompt: 'p', ...extra } });
const stub = (verdict) => async () => ({ verdict, judge: 'stub', ms: 1 });

test('parseVerdict reads JSON, also inside prose or a code fence', () => {
  assert.deepEqual(parseVerdict('{"difficulty":"Hard","confidence":0.8,"why":"x"}', LEVELS), { difficulty: 'hard', confidence: 0.8, why: 'x' });
  assert.equal(parseVerdict('```json\n{"difficulty":"easy","confidence":"0.9"}\n```', LEVELS).difficulty, 'easy');
  assert.match(parseVerdict('{"difficulty":"trivial","confidence":1}', LEVELS).error, /unknown difficulty/);
  assert.match(parseVerdict('{"difficulty":"easy"}', LEVELS).error, /confidence/);
  assert.match(parseVerdict('nope', LEVELS).error, /no JSON/);
  assert.match(parseVerdict('{bad json}', LEVELS).error, /not valid JSON/);
});

test('model names map to the Agent tool aliases', () => {
  assert.equal(toModelAlias('claude-opus-5-5'), 'opus');
  assert.equal(toModelAlias('Haiku'), 'haiku');
  assert.equal(toModelAlias('sonnet'), 'sonnet');
  assert.equal(toModelAlias('gpt-6'), undefined);
  assert.equal(toEffort('HIGH'), 'high');
  assert.equal(toEffort('ultra'), undefined);
});

test('fieldsAllowed follows the env vars that drop fields from the Agent schema', () => {
  assert.deepEqual(fieldsAllowed({}), { model: true, effort: true });
  assert.deepEqual(fieldsAllowed({ CLAUDE_CODE_EFFORT_LEVEL: 'auto' }), { model: true, effort: true });
  assert.deepEqual(fieldsAllowed({ CLAUDE_CODE_EFFORT_LEVEL: 'max' }), { model: true, effort: false });
  assert.equal(fieldsAllowed({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }).model, false);
});

test('decide: override at the threshold, unchanged just below it', async () => {
  const cfg = DEFAULT_CONFIG;
  const at = await decide(input(), { env: {}, cfg, judge: stub({ difficulty: 'hard', confidence: 0.75, why: '' }) });
  assert.equal(at.output.hookSpecificOutput.updatedInput.model, 'opus');
  const below = await decide(input(), { env: {}, cfg, judge: stub({ difficulty: 'hard', confidence: 0.74, why: '' }) });
  assert.equal(below.output.hookSpecificOutput, undefined);
  assert.match(below.output.systemMessage, /unsure 0\.74/);
});

test('decide: always sets the model even when the judge agrees with the caller', async () => {
  const r = await decide(input({ model: 'opus' }), { env: {}, cfg: DEFAULT_CONFIG, judge: stub({ difficulty: 'hard', confidence: 0.9, why: '' }) });
  assert.equal(r.output.hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(r.log.action, 'override');
});

test('decide: setEffort false leaves effort as the caller had it', async () => {
  const cfg = { ...DEFAULT_CONFIG, setEffort: false };
  const r = await decide(input({ effort: 'max' }), { env: {}, cfg, judge: stub({ difficulty: 'easy', confidence: 0.9, why: '' }) });
  const u = r.output.hookSpecificOutput.updatedInput;
  assert.equal(u.model, 'haiku');
  assert.equal(u.effort, 'max');
});

test('decide: a judge that throws never escapes', async () => {
  const r = await askJudge({ prompt: 'x' }, { ...DEFAULT_CONFIG, useApiKey: false }, {}, {
    cli: async () => { throw new Error('kaboom'); },
  });
  assert.match(r.error, /kaboom/);
});

// ---- the line shown to the user ----
const base = { description: 'slugify with tests', model_before: 'sonnet', effort_before: null, judge_ms: 3420 };
const fm = (log, display) => formatMessage({ ...base, ...log }, { ...DEFAULT_CONFIG, ...(display ? { display } : {}) });

test('formatMessage: override', () => {
  assert.equal(fm({ status: 'override', difficulty: 'medium', confidence: 0.9, model_after: 'sonnet', effort_after: 'medium' }),
    '⚖ judge-router: "slugify with tests" → medium 0.90 · sonnet→sonnet · effort medium (3.4s)');
  assert.equal(fm({ status: 'override', difficulty: 'easy', confidence: 1, model_before: null, model_after: 'haiku', effort_after: 'low', judge_ms: 2950 }),
    '⚖ judge-router: "slugify with tests" → easy 1.00 · default→haiku · effort low (3.0s)');
  assert.equal(fm({ status: 'override', difficulty: 'hard', confidence: 0.8, model_after: 'opus', effort_after: null }),
    '⚖ judge-router: "slugify with tests" → hard 0.80 · sonnet→opus (3.4s)');
});

test('formatMessage: unsure, failed, skipped', () => {
  assert.equal(fm({ description: 'vague task', status: 'unsure', difficulty: 'easy', confidence: 0.35 }),
    '⚖ judge-router: "vague task" unsure 0.35 (easy?) → left as sonnet (3.4s)');
  assert.equal(fm({ status: 'failed', reason: 'judge failed: cli: claude -p timed out after 15000 ms', judge_ms: 15003 }),
    '⚖ judge-router: "slugify with tests" judge failed (cli: claude -p timed out after 15000 ms) → left as sonnet (15.0s)');
  assert.equal(fm({ status: 'skipped', reason: 'fork: Claude Code ignores model and effort for forks', judge_ms: undefined, model_before: null }),
    '⚖ judge-router: "slugify with tests" skipped (fork) → left as default');
});

test('formatMessage: guard and other tools say nothing; long names are clipped', () => {
  assert.equal(fm({ status: 'guard' }), undefined);
  assert.equal(fm({ status: 'not-agent' }), undefined);
  const m = fm({ description: 'x'.repeat(80), status: 'override', difficulty: 'easy', confidence: 0.9, model_after: 'haiku', effort_after: 'low' });
  assert.match(m, /"x{47}…"/);
});

test('formatMessage: display modes', () => {
  const same = { status: 'override', difficulty: 'medium', confidence: 0.9, model_after: 'sonnet', effort_after: null };
  const changed = { status: 'override', difficulty: 'easy', confidence: 0.9, model_after: 'haiku', effort_after: 'low' };
  assert.equal(fm(same, 'changes'), undefined);
  assert.match(fm(changed, 'changes'), /sonnet→haiku/);
  assert.equal(fm({ status: 'unsure', difficulty: 'easy', confidence: 0.3 }, 'changes'), undefined);
  assert.match(fm({ status: 'failed', reason: 'judge failed: x' }, 'changes'), /judge failed/);
  assert.equal(fm({ status: 'skipped', reason: 'fork: x' }, 'changes'), undefined);
  assert.equal(fm(changed, 'off'), undefined);
});
