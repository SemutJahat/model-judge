#!/usr/bin/env node
// model-judge UserPromptSubmit hook: the opt-in delegation nudge ("delegationNudge": "on" in a config file).
// Reads the hook input on stdin; for a prompt worth judging, asks the judge whether the task splits into parts
// that can run independently and, if so, adds context suggesting the main agent delegate them. Logs judged
// prompts (kind "nudge"). Whatever happens it exits 0 and never blocks the prompt.
import { decideNudge, writeLog } from './lib.mjs';

try {
  if (process.env.MODEL_JUDGE_INNER === '1') process.exit(0);
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let hookInput;
  try { hookInput = JSON.parse(raw); } catch { process.exit(0); }
  const { output, log } = await decideNudge(hookInput);
  if (log) writeLog(log);
  if (output) process.stdout.write(JSON.stringify(output));
} catch (e) {
  try { writeLog({ ts: new Date().toISOString(), kind: 'nudge', status: 'failed', reason: `hook error: ${e?.message || e}` }); } catch {}
}
process.exit(0);
