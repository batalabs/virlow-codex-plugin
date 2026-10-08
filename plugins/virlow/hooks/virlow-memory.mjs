#!/usr/bin/env node
/**
 * Virlow memory hooks for Codex.
 *
 * The Virlow connector already tells every client, in its MCP handshake, to
 * recall with search_memory before a task and to save durable facts with
 * add_memory without being asked. That is advice; the model may follow it or
 * not. Codex hooks run whether or not the model remembers, so this turns the
 * advice into a routine:
 *
 *   session-start  SessionStart. Puts a short recall instruction in context,
 *                  naming this project's memory namespace (the git
 *                  repository's folder name, or the working folder's).
 *   prompt         UserPromptSubmit. Counts the session's turns.
 *   saved          PostToolUse on add_memory / update_memory. Marks the
 *                  session as having saved a memory.
 *   stop           Stop. If the session had at least MIN_TURNS_FOR_NUDGE turns,
 *                  saved nothing and was not nudged yet, asks Codex once to
 *                  save what is durable. Codex continues with the reason as a
 *                  new prompt and calls Stop again with stop_hook_active set,
 *                  which is always let through, so it can never loop.
 *   session-end    SessionEnd. Forgets this session's counters.
 *
 * Rules every event follows: no dependencies beyond Node, never exit
 * non-zero, and print nothing when anything is off. A memory hook must never
 * be the reason a turn fails. VIRLOW_MEMORY_HOOKS=off turns all of it off.
 *
 * The hook never reads the transcript (its format is not a stable interface),
 * never calls Virlow, and never sees note content, the master password or any
 * key. It only keeps a few counters per session and asks the model to use the
 * connector's tools.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Turns a session needs before the stop nudge fires. One question and an
 *  answer rarely produce a fact worth keeping; three exchanges often do. */
export const MIN_TURNS_FOR_NUDGE = 3;

/** Where per-session counters live: the plugin's writable data directory that
 *  Codex passes as PLUGIN_DATA, or the OS temp directory when run by hand. */
export function stateDir(env = process.env) {
  return env.PLUGIN_DATA ? path.join(env.PLUGIN_DATA, 'sessions') : path.join(tmpdir(), 'virlow-codex-plugin');
}

/** The project's memory namespace: the git repository's folder name, or the
 *  working folder's when there is no repository. */
export function namespaceFor(cwd) {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    if (existsSync(path.join(dir, '.git'))) return path.basename(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.basename(cwd);
}

function statePath(sessionId, env) {
  // The session id comes from Codex; keep only characters safe in a file name.
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(stateDir(env), `${safe}.json`);
}

export function readState(sessionId, env = process.env) {
  try {
    const state = JSON.parse(readFileSync(statePath(sessionId, env), 'utf8'));
    return {
      turns: Number(state.turns) || 0,
      saved: state.saved === true,
      nudged: state.nudged === true,
    };
  } catch {
    return { turns: 0, saved: false, nudged: false };
  }
}

function writeState(sessionId, state, env) {
  try {
    mkdirSync(stateDir(env), { recursive: true });
    writeFileSync(statePath(sessionId, env), JSON.stringify(state));
  } catch {
    // No state means no nudge this time; never an error.
  }
}

export function sessionStartText(ns) {
  return (
    `Virlow memory is connected. This project's memory namespace is "${ns}". At the start of a task, ` +
    `call the Virlow search_memory tool with the topic of the task and namespace "${ns}", and follow the ` +
    'virlow-memory skill. When the user shares something that will still be true next week (a decision, a ' +
    'convention, a preference, a fact about the environment), save it with add_memory, one fact per call, and ' +
    'tell the user "Saved to Virlow: ..." in one line. Never save secrets, credentials, health details, ' +
    'financial account numbers or government ID numbers, and save nothing the user asks you not to remember. ' +
    'If a Virlow tool says the vault is locked, tell the user once and carry on without memory.'
  );
}

export function stopNudgeText(ns) {
  return (
    'Virlow memory check before you stop. If this session produced anything that will still be true next ' +
    'week (a decision, a convention, a preference, a fact about the environment), save each one with ' +
    `add_memory: a short label and the fact itself, namespace "${ns}" for project facts and none for ` +
    'personal preferences. Then tell the user "Saved to Virlow: ..." in one line. Skip anything transient, ' +
    'secret or that the user asked you not to remember. If nothing qualifies, or saving is unavailable, say ' +
    'so in one line and stop.'
  );
}

/** Decides what Stop does, given the session's state. Pure, for tests. */
export function decideStop({ stopHookActive, saved, nudged, turns }) {
  if (stopHookActive) return 'allow';
  if (saved || nudged) return 'allow';
  if (turns < MIN_TURNS_FOR_NUDGE) return 'allow';
  return 'nudge';
}

/** What each event prints on stdout, given its input. Empty means "carry on".
 *  Exported for tests. */
export function handle(event, input, env = process.env) {
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const sessionId = input.session_id;

  switch (event) {
    case 'session-start':
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: sessionStartText(namespaceFor(cwd)),
        },
      });

    case 'prompt': {
      const state = readState(sessionId, env);
      state.turns += 1;
      writeState(sessionId, state, env);
      return '';
    }

    case 'saved': {
      const state = readState(sessionId, env);
      state.saved = true;
      writeState(sessionId, state, env);
      return '';
    }

    case 'stop': {
      const state = readState(sessionId, env);
      const decision = decideStop({
        stopHookActive: input.stop_hook_active === true,
        saved: state.saved,
        nudged: state.nudged,
        turns: state.turns,
      });
      if (decision !== 'nudge') return '';
      state.nudged = true;
      writeState(sessionId, state, env);
      return JSON.stringify({ decision: 'block', reason: stopNudgeText(namespaceFor(cwd)) });
    }

    case 'session-end':
      try {
        rmSync(statePath(sessionId, env), { force: true });
      } catch {
        // Already gone.
      }
      return '';

    default:
      return '';
  }
}

async function main() {
  if ((process.env.VIRLOW_MEMORY_HOOKS || '').toLowerCase() === 'off') return;
  const event = process.argv[2] || '';
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    input = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    input = {};
  }
  const out = handle(event, input);
  if (out) process.stdout.write(out);
}

/** True when Node runs this file as a script (not when tests import it).
 *  Compares real paths, since PLUGIN_ROOT may sit behind a symlink. */
function invokedDirectly() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
