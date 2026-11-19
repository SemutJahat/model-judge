#!/usr/bin/env node
// Stand-in for `claude -p` in tests. Answers like `claude -p --output-format json`, by keywords in the prompt:
// HARD / MEDIUM / UNSURE / ERROR (exit 1) / GARBAGE (no JSON) / SLOW (sleeps 5 s); anything else: easy.
// With the delegation nudge's system prompt: SPLIT / COUPLED / UNSURE (see below).
// Writes what it was called with to $FAKE_CLAUDE_RECORD (if set) so tests can check flags and the recursion guard.
import { appendFileSync } from 'node:fs';

let prompt = '';
for await (const c of process.stdin) prompt += c;
const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_RECORD) {
  appendFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({
    args, cwd: process.cwd(), inner: process.env.MODEL_JUDGE_INNER ?? null, prompt,
  }) + '\n');
}
const reply = (result) => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result }));
const verdict = (difficulty, confidence, why) => reply(JSON.stringify({ difficulty, confidence, why }));

if (prompt.includes('ERROR:')) { process.stderr.write('fake failure\n'); process.exit(1); }
if (prompt.includes('SLOW:')) await new Promise((r) => setTimeout(r, 5000));
const system = args[args.indexOf('--system-prompt') + 1] ?? '';
const nudge = (difficulty, confidence, why, parts) => reply(JSON.stringify({ why, difficulty, confidence, parts }));
if (prompt.includes('GARBAGE:')) reply('I would say this one is fairly easy.');
// The delegation-nudge judge (its own system prompt): SPLIT (3 parts) / COUPLED (hard, no parts) / UNSURE; else easy.
else if (system.startsWith('You help a coding agent decide')) {
  if (prompt.includes('SPLIT:')) nudge('hard', 0.86, 'three separate pieces of work', [
    { task: 'Add the /export endpoint in server/', difficulty: 'medium' },
    { task: 'Count the TODOs in docs/', difficulty: 'easy' },
    { task: 'Design the cache invalidation scheme', difficulty: 'hard' },
  ]);
  else if (prompt.includes('COUPLED:')) nudge('hard', 0.9, 'one tightly coupled refactor', []);
  else if (prompt.includes('UNSURE:')) nudge('medium', 0.4, 'too vague', [{ task: 'a' }, { task: 'b' }]);
  else nudge('easy', 0.95, 'a quick question', []);
}
else if (prompt.includes('HARD')) verdict('hard', 0.93, 'deep concurrent design');
else if (prompt.includes('MEDIUM:')) verdict('medium', 0.85, 'a feature across a few files');
else if (prompt.includes('UNSURE:')) verdict('medium', 0.4, 'too vague to tell');
else verdict('easy', 0.97, 'a bounded lookup');
