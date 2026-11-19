#!/usr/bin/env node
// Stable status-line launcher for model-judge. Copy it outside the plugin, e.g. to
// ~/.claude/model-judge/statusline.mjs, and point settings.json's statusLine at the copy. It finds the
// installed model-judge (its installPath in ~/.claude/plugins/installed_plugins.json, which an update
// changes) and runs that version's scripts/statusline.mjs, so the status line survives plugin updates.
// Prints nothing if model-judge isn't installed. MODEL_JUDGE_ROOT names a plugin folder to use instead.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function findRoot(env = process.env) {
  if (env.MODEL_JUDGE_ROOT) return env.MODEL_JUDGE_ROOT;
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  try {
    const j = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    const keys = Object.keys(j.plugins || {}).filter((k) => k.startsWith('model-judge@'));
    // Prefer the GitHub marketplace's install, then any other; within one, the user-scope entry.
    keys.sort((a, b) => (b === 'model-judge@claude-judge') - (a === 'model-judge@claude-judge'));
    for (const k of keys) {
      const entries = j.plugins[k] || [];
      const e = entries.find((x) => x.scope === 'user') || entries[0];
      if (e?.installPath && existsSync(join(e.installPath, 'scripts', 'statusline.mjs'))) return e.installPath;
    }
  } catch {}
  return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  try { for await (const c of process.stdin) input += c; } catch {}
  const root = findRoot();
  if (root) {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'statusline.mjs')], { input, encoding: 'utf8', timeout: 5000 });
    if (r.stdout) process.stdout.write(r.stdout);
  }
}
