// Unit tests of the pure parts of lib.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, toModelAlias, toEffort, fieldsAllowed, decide, DEFAULT_CONFIG, askJudge } from '../scripts/lib.mjs';

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
  assert.equal(below.output, null);
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
