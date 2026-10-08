import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const pluginDir = 'plugins/virlow';
const marketplace = json('.agents/plugins/marketplace.json');
const plugin = json(`${pluginDir}/plugin.json`);
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/** A relative path a manifest may use: starts with ./ and stays inside. */
function insidePlugin(p) {
  assert.match(p, /^\.\//, `${p} starts with ./`);
  const full = path.resolve(root, pluginDir, p);
  assert.ok(full.startsWith(path.resolve(root, pluginDir) + path.sep), `${p} stays inside the plugin`);
  assert.ok(existsSync(full), `${p} exists`);
}

test('the marketplace lists the plugin at its own folder, with the fields Codex requires', () => {
  assert.equal(marketplace.name, 'virlow');
  assert.ok(marketplace.interface.displayName);
  assert.equal(marketplace.plugins.length, 1);
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, plugin.name);
  assert.deepEqual(entry.source, { source: 'local', path: `./${pluginDir}` });
  assert.ok(['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE'].includes(entry.policy.installation));
  assert.ok(['ON_INSTALL', 'ON_USE'].includes(entry.policy.authentication));
  assert.ok(entry.category);
  assert.ok(existsSync(path.join(root, entry.source.path, 'plugin.json')));
});

test('plugin.json follows the Agent Plugins 1.0.0 manifest schema', () => {
  const allowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
  assert.equal(plugin.$schema, PLUGIN_SCHEMA);
  assert.deepEqual(Object.keys(plugin).filter((k) => !allowed.includes(k)), []);
  assert.ok(plugin.name.length >= 1 && plugin.name.length <= 64);
  assert.match(plugin.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.ok(plugin.description.length > 20);
  assert.deepEqual(Object.keys(plugin.author).filter((k) => !['name', 'email', 'url'].includes(k)), []);
  for (const k of ['homepage', 'repository', 'license']) assert.equal(typeof plugin[k], 'string', k);
  assert.ok(plugin.keywords.every((k) => typeof k === 'string'));
  for (const value of Object.values(plugin.extensions)) assert.equal(typeof value, 'object');
});

test('the OpenAI extension points at the hooks and assets inside the plugin', () => {
  const openai = plugin.extensions['com.openai'];
  assert.equal(openai.hooks, './hooks/hooks.json');
  insidePlugin(openai.hooks);
  const ui = openai.interface;
  assert.equal(ui.displayName, 'Virlow');
  assert.ok(ui.shortDescription && ui.longDescription && ui.developerName && ui.category);
  for (const p of [ui.composerIcon, ui.logo]) insidePlugin(p);
  for (const url of [ui.websiteURL, ui.privacyPolicyURL, ui.termsOfServiceURL]) assert.match(url, /^https:\/\/virlow\.com/);
  // No .codex-plugin overlay: the inline extension is the one source.
  assert.ok(!existsSync(path.join(root, pluginDir, '.codex-plugin')));
});

test('mcp.json follows the Agent Plugins MCP schema and runs the public virlow-mcp package', () => {
  const mcp = json(`${pluginDir}/mcp.json`);
  assert.equal(mcp.$schema, MCP_SCHEMA);
  assert.deepEqual(Object.keys(mcp).sort(), ['$schema', 'mcpServers']);
  assert.deepEqual(mcp.mcpServers, {
    virlow: { type: 'stdio', command: 'npx', args: ['-y', 'virlow-mcp@latest'] },
  });
});

test('every hook runs the one script, for an event Codex supports and the script handles', () => {
  const file = json(`${pluginDir}/hooks/hooks.json`);
  assert.deepEqual(Object.keys(file).sort(), ['description', 'hooks']);
  const script = read(`${pluginDir}/hooks/virlow-memory.mjs`);
  const expected = {
    SessionStart: 'session-start',
    UserPromptSubmit: 'prompt',
    PostToolUse: 'saved',
    Stop: 'stop',
    SessionEnd: 'session-end',
  };
  assert.deepEqual(Object.keys(file.hooks).sort(), Object.keys(expected).sort());
  for (const [event, arg] of Object.entries(expected)) {
    assert.equal(file.hooks[event].length, 1, `${event} has one matcher group`);
    const [{ hooks: [hook], ...group }] = file.hooks[event];
    assert.deepEqual(Object.keys(hook).sort(), ['command', 'commandWindows', 'timeout', 'type']);
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, `node "\${PLUGIN_ROOT}/hooks/virlow-memory.mjs" ${arg}`);
    assert.equal(hook.commandWindows, `node "%PLUGIN_ROOT%\\hooks\\virlow-memory.mjs" ${arg}`);
    assert.ok(hook.timeout >= 1 && hook.timeout <= (event === 'SessionEnd' ? 3 : 30), `${event} has a short timeout`);
    assert.ok(script.includes(`case '${arg}':`), `the script handles ${arg}`);
    // Codex ignores matchers on UserPromptSubmit and Stop; do not pretend.
    if (event === 'UserPromptSubmit' || event === 'Stop') assert.equal(group.matcher, undefined);
  }
  assert.equal(file.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  const saved = new RegExp(file.hooks.PostToolUse[0].matcher);
  for (const name of ['mcp__virlow__add_memory', 'mcp__virlow__update_memory', 'mcp__VIRLOW__add_memory']) {
    assert.ok(saved.test(name), name);
  }
  for (const name of ['mcp__virlow__search_memory', 'mcp__virlow__delete_memory', 'Bash']) {
    assert.ok(!saved.test(name), name);
  }
});

test('the hook script has no dependencies beyond Node itself and never reads the transcript', () => {
  const script = read(`${pluginDir}/hooks/virlow-memory.mjs`);
  const imports = [...script.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.every((m) => m.startsWith('node:')), `imports: ${imports.join(', ')}`);
  assert.ok(!/input\.transcript_path|fetch\(|node:https?'/.test(script));
});

test('skills carry the front matter Codex reads, in their own folders', () => {
  const dirs = readdirSync(path.join(root, pluginDir, 'skills')).sort();
  assert.deepEqual(dirs, ['tidy', 'virlow-memory']);
  for (const dir of dirs) {
    const front = read(`${pluginDir}/skills/${dir}/SKILL.md`).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    assert.match(front, new RegExp(`^name: ${dir}$`, 'm'));
    assert.match(front, /^description: .{40,}$/m);
  }
});

test('the memory skill keeps the privacy rules', () => {
  const skill = read(`${pluginDir}/skills/virlow-memory/SKILL.md`);
  for (const rule of [/search_memory/, /Saved to Virlow: /, /passwords/, /health/, /government ID/, /don't\s+remember this/, /Virlow Pro/, /opt-in/]) {
    assert.match(skill, rule);
  }
});

test('no em or en dashes in the prose', () => {
  for (const p of ['README.md', `${pluginDir}/skills/virlow-memory/SKILL.md`, `${pluginDir}/skills/tidy/SKILL.md`, `${pluginDir}/plugin.json`]) {
    assert.ok(!/[\u2013\u2014]/.test(read(p)), p);
  }
});
