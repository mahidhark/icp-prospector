import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertMention, unobservedMentions, saveObservation } from './db.js';
import type { Mention } from '../sources/types.js';

const mention: Mention = {
  source: 'reddit', externalId: 't3_a', kind: 'post', url: 'u', community: 'n8n',
  author: null, title: 'T', body: 'B', createdAt: null, query: 'r/n8n',
};

test('a mention is stored once per ICP', () => {
  const db = openDb(':memory:');
  assert.equal(upsertMention(db, 'x', mention), true);
  assert.equal(upsertMention(db, 'x', mention), false);
  assert.equal(upsertMention(db, 'y', mention), true);
});

test('observed mentions are not re-read', () => {
  const db = openDb(':memory:');
  upsertMention(db, 'x', mention);
  assert.equal(unobservedMentions(db, 'x').length, 1);
  saveObservation(db, 'x', { source: 'reddit', external_id: 't3_a', relevant: 0, speaker: 'other', pain: null, quote: null, hypotheses: null }, 'm');
  assert.equal(unobservedMentions(db, 'x').length, 0);
});

test('extraction reads search results and only relevant Reddit posts, once', async () => {
  const { upsertSerpHit, unextractedItems, markExtracted, saveObservation: save } = await import('./db.js');
  const db = openDb(':memory:');
  upsertSerpHit(db, 'x', { query: 'q', signal: 'zapier-app', url: 'https://z.com/a', title: 'T', description: 'D', position: 1, content: null });
  upsertMention(db, 'x', mention);
  upsertMention(db, 'x', { ...mention, externalId: 't3_b' });
  save(db, 'x', { source: 'reddit', external_id: 't3_a', relevant: 1, speaker: 'other', pain: 'p', quote: null, hypotheses: null }, 'm');
  save(db, 'x', { source: 'reddit', external_id: 't3_b', relevant: 0, speaker: 'other', pain: null, quote: null, hypotheses: null }, 'm');
  const items = unextractedItems(db, 'x');
  assert.deepEqual(items.map((i) => [i.source, i.signal]), [['google', 'zapier-app'], ['reddit', null]]);
  for (const i of items) markExtracted(db, 'x', i, 'm');
  assert.equal(unextractedItems(db, 'x').length, 0);
});

test('repair clears mismatched domains and merges companies sharing one', async () => {
  const { upsertCompany, addEvidence, repairCompanies, companiesFor, evidenceFor } = await import('./db.js');
  const { domainMatchesName } = await import('../resolve/extract.js');
  const db = openDb(':memory:');
  const it = (ref: string) => ({ source: 'google' as const, ref, url: `https://e.com/${ref}`, text: 't', signal: null });
  upsertCompany(db, 'x', 'aisensy', 'AiSensy', 'kraya-ai.com');
  upsertCompany(db, 'x', 'kraya', 'Kraya', 'kraya-ai.com');
  upsertCompany(db, 'x', 'krayaai', 'Kraya AI', 'kraya-ai.com');
  addEvidence(db, 'x', 'kraya', it('1'), 's');
  addEvidence(db, 'x', 'krayaai', it('2'), 's');
  addEvidence(db, 'x', 'krayaai', it('3'), 's');
  assert.deepEqual(repairCompanies(db, 'x', domainMatchesName), { cleared: 1, merged: 1 });
  assert.deepEqual(companiesFor(db, 'x').map((c) => [c.key, c.domain]), [['aisensy', null], ['krayaai', 'kraya-ai.com']]);
  assert.equal(evidenceFor(db, 'x').filter((e) => e.key === 'krayaai').length, 3);
  assert.deepEqual(repairCompanies(db, 'x', domainMatchesName), { cleared: 0, merged: 0 });
});

test('a new capability query clears the judgement so it is re-judged', async () => {
  const { saveCapability, capabilitiesFor, saveCapabilityHits, clearCapability, capabilityQueriesDone } = await import('./db.js');
  const db = openDb(':memory:');
  saveCapability(db, 'x', { key: 'a', capability: 'ai-depth', status: 'chatbot', quote: 'q', url: 'u' }, 'm');
  saveCapabilityHits(db, 'x', 'a', 'ai-depth', '"A" features', [{ url: 'https://a.com/f', title: 'A features', description: 'd' }]);
  clearCapability(db, 'x', 'a', 'ai-depth');
  assert.equal(capabilitiesFor(db, 'x').length, 0);
  assert.ok(capabilityQueriesDone(db, 'x').has('a|"A" features'));
});
