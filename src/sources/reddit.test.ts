import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRedditRuns, normaliseRedditItem } from './reddit.js';
import { RedditSourceSchema } from '../icp/schema.js';

const cfg = RedditSourceSchema.parse({ communities: ['n8n', 'whatsapp'], searches: ['whatsapp api'], maxItemsPerRun: 50 });

test('one run per community plus one site-wide', () => {
  const runs = planRedditRuns(cfg);
  assert.deepEqual(runs.map((r) => r.community), ['n8n', 'whatsapp', null]);
  assert.equal(runs[0]!.input.searchCommunityName, 'n8n');
  assert.equal('searchCommunityName' in runs[2]!.input, false);
});

test('worst case is start fee plus every item slot', () => {
  const [run] = planRedditRuns(cfg);
  assert.equal(run!.worstCaseUsd.toFixed(3), (0.02 + 0.004 * 50).toFixed(3));
});

test('site-wide can be turned off', () => {
  assert.equal(planRedditRuns({ ...cfg, siteWide: false }).length, 2);
});

test('posts and comments normalise; everything else is dropped', () => {
  const post = normaliseRedditItem({ id: 't3_a', dataType: 'post', url: 'https://reddit.com/r/n8n/a', title: 'T', body: 'B', parsedCommunityName: 'n8n' }, 'r/n8n');
  assert.equal(post?.kind, 'post');
  assert.equal(post?.community, 'n8n');
  assert.equal(normaliseRedditItem({ id: 'x', dataType: 'community', url: 'u', body: 'b' }, null), null);
  assert.equal(normaliseRedditItem({ id: 'x', dataType: 'comment', url: 'u', body: '[deleted]' }, null), null);
  assert.equal(normaliseRedditItem({ dataType: 'post', url: 'u', body: 'b' }, null), null);
});

test('community falls back to communityName without the r/ prefix', () => {
  const c = normaliseRedditItem({ id: 't1_b', dataType: 'comment', url: 'u', body: 'hi', communityName: 'r/SaaS' }, null);
  assert.equal(c?.community, 'SaaS');
});
