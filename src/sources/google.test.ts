import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGoogleRuns, normaliseGoogleItem, worstCaseForQueries, CONTENT_LIMIT } from './google.js';
import { GoogleSourceSchema } from '../icp/schema.js';

const cfg = GoogleSourceSchema.parse({
  countryCode: 'in',
  queries: [
    { query: 'site:zapier.com/apps whatsapp', signal: 'zapier-app', pages: 3 },
    { query: 'whatsapp api india' },
    { query: 'interakt alternatives', fetchContent: true },
    { query: 'aisensy alternatives', fetchContent: true },
  ],
});

test('queries group into one run per page count and content setting', () => {
  const runs = planGoogleRuns(cfg);
  assert.equal(runs.length, 3);
  const content = runs.find((r) => r.queries[0]!.fetchContent)!;
  assert.equal(content.input.queries, 'interakt alternatives\naisensy alternatives');
  assert.deepEqual(content.input.websiteContentScraper, { enable: true });
  assert.equal(content.input.countryCode, 'in');
});

test('worst case counts every SERP page and, with content, every result page', () => {
  const [q] = GoogleSourceSchema.parse({ queries: [{ query: 'abc', pages: 2, fetchContent: true }] }).queries;
  assert.equal(worstCaseForQueries([q!]).toFixed(4), (0.001 + 2 * 0.0045 + 2 * 10 * 0.008).toFixed(4));
});

test('results carry their query signal; missing url or title is dropped; content is capped', () => {
  const hits = normaliseGoogleItem({
    searchQuery: { term: 'site:zapier.com/apps whatsapp' },
    organicResults: [
      { url: 'https://zapier.com/apps/aisensy/integrations', title: 'AiSensy Integrations', description: 'Connect AiSensy', position: 1 },
      { url: 'https://x.com', title: '' },
      { url: 'https://y.com', title: 'Y', websiteContent: { text: 'z'.repeat(CONTENT_LIMIT + 50) } },
    ],
  }, cfg.queries);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.signal, 'zapier-app');
  assert.equal(hits[1]!.content!.length, CONTENT_LIMIT);
});
