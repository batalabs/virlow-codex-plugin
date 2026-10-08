import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MIN_TURNS_FOR_NUDGE,
  decideStop,
  handle,
  namespaceFor,
  readState,
} from '../plugins/virlow/hooks/virlow-memory.mjs';

const script = fileURLToPath(new URL('../plugins/virlow/hooks/virlow-memory.mjs', import.meta.url));
const repo = mkdtempSync(path.join(tmpdir(), 'virlow-codex-hook-'));
const project = path.join(repo, 'atlas');
mkdirSync(path.join(project, '.git'), { recursive: true });
mkdirSync(path.join(project, 'src', 'deep'), { recursive: true });
// Codex passes the plugin's writable data directory as PLUGIN_DATA.
const env = { PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), 'virlow-codex-data-')) };
const session = () => `t-${Math.random().toString(36).slice(2)}`;
const ev = (event, input) => handle(event, { cwd: project, ...input }, env);
const turns = (id, n) => {
  for (let i = 0; i < n; i++) assert.equal(ev('prompt', { session_id: id, prompt: 'a real question' }), '');
};

test('the namespace is the git repository, from anywhere inside it', () => {
  assert.equal(namespaceFor(path.join(project, 'src', 'deep')), 'atlas');
  assert.equal(namespaceFor(repo), path.basename(repo));
});

test('SessionStart adds the recall instruction as additional context', () => {
  const out = JSON.parse(ev('session-start', { session_id: session(), source: 'startup' }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /search_memory/);
  assert.match(text, /namespace "atlas"/);
  assert.match(text, /Saved to Virlow: \.\.\./);
  assert.match(text, /Never save secrets/);
});

test('UserPromptSubmit only counts turns and adds nothing', () => {
  const id = session();
  turns(id, 2);
  assert.equal(readState(id, env).turns, 2);
});

test('Stop lets a short session finish', () => {
  const id = session();
  turns(id, MIN_TURNS_FOR_NUDGE - 1);
  assert.equal(ev('stop', { session_id: id, stop_hook_active: false }), '');
});

test('Stop nudges once after enough turns with nothing saved, and never loops', () => {
  const id = session();
  turns(id, MIN_TURNS_FOR_NUDGE);
  const nudge = JSON.parse(ev('stop', { session_id: id, stop_hook_active: false }));
  assert.equal(nudge.decision, 'block');
  assert.match(nudge.reason, /add_memory/);
  assert.match(nudge.reason, /namespace "atlas"/);
  // Codex continues with the reason as a new prompt, then calls Stop again
  // with stop_hook_active set.
  turns(id, 1);
  assert.equal(ev('stop', { session_id: id, stop_hook_active: true }), '');
  // And never nudges again in this session.
  turns(id, MIN_TURNS_FOR_NUDGE);
  assert.equal(ev('stop', { session_id: id, stop_hook_active: false }), '');
});

test('PostToolUse on add_memory or update_memory marks the session saved, so Stop stays quiet', () => {
  const id = session();
  turns(id, MIN_TURNS_FOR_NUDGE + 2);
  assert.equal(ev('saved', { session_id: id, tool_name: 'mcp__virlow__add_memory' }), '');
  assert.equal(readState(id, env).saved, true);
  assert.equal(ev('stop', { session_id: id, stop_hook_active: false }), '');
});

test('the stop decision is pure', () => {
  const base = { stopHookActive: false, saved: false, nudged: false, turns: MIN_TURNS_FOR_NUDGE };
  assert.equal(decideStop(base), 'nudge');
  assert.equal(decideStop({ ...base, stopHookActive: true }), 'allow');
  assert.equal(decideStop({ ...base, saved: true }), 'allow');
  assert.equal(decideStop({ ...base, nudged: true }), 'allow');
  assert.equal(decideStop({ ...base, turns: MIN_TURNS_FOR_NUDGE - 1 }), 'allow');
});

test('SessionEnd forgets the session', () => {
  const id = session();
  turns(id, 2);
  assert.equal(ev('session-end', { session_id: id, reason: 'other' }), '');
  assert.deepEqual(readState(id, env), { turns: 0, saved: false, nudged: false });
});

test('a hostile session id cannot escape the state directory', () => {
  ev('prompt', { session_id: '../../etc/passwd' });
  const dir = path.join(env.PLUGIN_DATA, 'sessions');
  assert.ok(readdirSync(dir).every((name) => !name.includes('/')));
  assert.equal(readState('../../etc/passwd', env).turns, 1);
});

test('as a process it never fails, even on bad input, and can be switched off', () => {
  const run = (args, input, extra = {}) =>
    spawnSync(process.execPath, [script, ...args], { input, env: { ...process.env, ...env, ...extra } });

  for (const event of ['session-start', 'prompt', 'saved', 'stop', 'session-end', 'unknown', '']) {
    const bad = run([event], 'not json');
    assert.equal(bad.status, 0, `${event} exits 0 on bad input`);
  }

  const off = run(['session-start'], JSON.stringify({ cwd: project, session_id: session() }), {
    VIRLOW_MEMORY_HOOKS: 'off',
  });
  assert.equal(off.status, 0);
  assert.equal(off.stdout.toString(), '');

  const on = run(['session-start'], JSON.stringify({ cwd: project, session_id: session() }));
  assert.equal(on.status, 0);
  assert.equal(JSON.parse(on.stdout.toString()).hookSpecificOutput.hookEventName, 'SessionStart');

  // Stop prints either nothing or valid JSON, never plain text.
  const id = session();
  for (let i = 0; i < MIN_TURNS_FOR_NUDGE; i++) run(['prompt'], JSON.stringify({ cwd: project, session_id: id }));
  const stop = run(['stop'], JSON.stringify({ cwd: project, session_id: id, stop_hook_active: false }));
  assert.equal(stop.status, 0);
  assert.equal(JSON.parse(stop.stdout.toString()).decision, 'block');
  const again = run(['stop'], JSON.stringify({ cwd: project, session_id: id, stop_hook_active: true }));
  assert.equal(again.stdout.toString(), '');
});
