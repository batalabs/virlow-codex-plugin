import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This repository is public. Fail the build if anything that looks like a
 * credential, a private address or an internal host ever lands in it.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules']);
const BINARY = /\.(png|jpe?g|gif|ico|webp)$/i;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['Stripe key', /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/],
  ['webhook secret', /\bwhsec_[A-Za-z0-9]{10,}\b/],
  ['API key', /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['private IP', /\b(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/],
  ['internal host', /\.internal\b|\.local\b|localhost:\d{4}/],
  ['password assignment', /\b(password|passwd|secret|token)\s*[:=]\s*['"][^'"]{6,}['"]/i],
  ['home directory path', /\/(Users|home)\/[a-z][a-z0-9_-]+\//],
  ['self-hosted git host', new RegExp(['git', 'ea'].join(''), 'i')],
];

test('no file holds a secret, a private address or an internal host', () => {
  const self = fileURLToPath(import.meta.url);
  const hits = [];
  for (const file of files(root)) {
    if (file === self || BINARY.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [what, re] of PATTERNS) {
      if (re.test(text)) hits.push(`${path.relative(root, file)}: ${what}`);
    }
  }
  assert.deepEqual(hits, []);
});
