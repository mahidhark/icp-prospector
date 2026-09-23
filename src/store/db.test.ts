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
