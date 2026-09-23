import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundQuote, toObservations, cleanThemes, renderThemes, type ObserveResult } from './themes.js';
import { parseIcp } from '../icp/load.js';
import type { MentionRow } from '../store/db.js';

const icp = parseIcp(`
name: t
description: a test ICP for unit tests
hypotheses:
  - id: h1
    statement: people bypass providers with n8n
sources:
  reddit:
    searches: [whatsapp]
`);

const m = (id: string, body: string): MentionRow => ({
  icp: 't', source: 'reddit', external_id: id, kind: 'post', url: `https://reddit.com/${id}`,
  community: 'n8n', author: 'a', title: null, body, created_at: null, query: null,
});

test('a verbatim quote survives; a paraphrase does not', () => {
  const text = 'We moved off our BSP and now call the Cloud API from n8n directly.';
  assert.equal(groundQuote('call the Cloud API from n8n directly', text), 'call the Cloud API from n8n directly');
  assert.equal(groundQuote('  CALL the cloud api\nfrom n8n directly ', text), 'CALL the cloud api\nfrom n8n directly');
  assert.equal(groundQuote('they use n8n with the Cloud API', text), null);
  assert.equal(groundQuote('short', text), null);
  assert.equal(groundQuote(null, text), null);
});

test('observations drop unknown ids, unknown hypotheses and ungrounded quotes', () => {
  const batch = [m('a', 'we call the Cloud API from n8n now'), m('b', 'unrelated')];
  const results: ObserveResult[] = [
    { id: 'reddit:a', relevant: true, speaker: 'builder_or_agency', pain: 'BSP too costly', quote: 'call the Cloud API from n8n', hypotheses: [{ id: 'h1', stance: 'supports' }, { id: 'nope', stance: 'supports' }] },
    { id: 'reddit:b', relevant: false, speaker: 'other', pain: 'x', quote: 'invented words here', hypotheses: [{ id: 'h1', stance: 'supports' }] },
    { id: 'reddit:zzz', relevant: true, speaker: 'other', pain: 'ghost', quote: null, hypotheses: [] },
  ];
  const rows = toObservations(batch, results, icp);
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0]!.hypotheses!), [{ id: 'h1', stance: 'supports' }]);
  assert.equal(rows[0]!.quote, 'call the Cloud API from n8n');
  assert.equal(rows[1]!.relevant, 0);
  assert.equal(rows[1]!.pain, null);
  assert.equal(rows[1]!.quote, null);
  assert.equal(rows[1]!.hypotheses, null);
});

test('themes keep only known ids, each id once, largest first', () => {
  const out = cleanThemes([
    { name: 'small', summary: 's', ids: ['a', 'ghost'] },
    { name: 'big', summary: 's', ids: ['a', 'b', 'c'] },
    { name: 'empty', summary: 's', ids: ['ghost'] },
  ], new Set(['a', 'b', 'c']));
  assert.deepEqual(out.map((t) => [t.name, t.ids]), [['big', ['b', 'c']], ['small', ['a']]]);
});

test('the report links quotes to their posts and counts hypothesis stances', () => {
  const mentions = [m('a', 'we call the Cloud API from n8n now')];
  const obs = toObservations(mentions, [
    { id: 'reddit:a', relevant: true, speaker: 'builder_or_agency', pain: 'bypass', quote: 'call the Cloud API from n8n', hypotheses: [{ id: 'h1', stance: 'supports' }] },
  ], icp);
  const md = renderThemes(icp, mentions, obs, [{ name: 'Direct API', summary: 'going direct', ids: ['reddit:a'] }], 'test', new Date('2026-09-23'));
  assert.match(md, /\| \*\*h1\*\* — people bypass providers with n8n \| 1 \| 0 \|/);
  assert.match(md, /> "call the Cloud API from n8n" — \[r\/n8n\]\(https:\/\/reddit.com\/a\)/);
  assert.match(md, /\| Direct API \| 1 \| builder_or_agency 1 \|/);
});
