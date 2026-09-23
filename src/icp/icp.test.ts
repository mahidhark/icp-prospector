import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIcp, resolveIcpPath } from './load.js';

const minimal = `
name: test-icp
description: a test ICP for unit tests
sources:
  reddit:
    searches: [whatsapp api]
`;

test('the shipped ICP file is valid', () => {
  const icp = parseIcp(readFileSync('icps/meta-tech-providers-india.yaml', 'utf8'));
  assert.equal(icp.name, 'meta-tech-providers-india');
  assert.ok(icp.hypotheses.length >= 1);
  assert.ok(icp.sources.reddit);
});

test('defaults fill in what a minimal file leaves out', () => {
  const icp = parseIcp(minimal);
  assert.deepEqual(icp.sources.reddit?.communities, []);
  assert.equal(icp.sources.reddit?.siteWide, true);
  assert.equal(icp.sources.reddit?.time, 'year');
});

test('a misspelt key is an error, not silently ignored', () => {
  assert.throws(() => parseIcp(minimal.replace('searches:', 'serches:')), /invalid ICP/);
  assert.throws(() => parseIcp(`${minimal}\nsurces: {}\n`), /invalid ICP/);
});

test('a subreddit given with r/ is rejected', () => {
  assert.throws(() => parseIcp(minimal.replace('searches:', 'communities: [r/n8n]\n    searches:')), /subreddit/);
});

test('bare names resolve into icps/, paths pass through', () => {
  assert.equal(resolveIcpPath('foo'), 'icps/foo.yaml');
  assert.equal(resolveIcpPath('x/y.yaml'), 'x/y.yaml');
});
