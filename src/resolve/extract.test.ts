import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyKey, hostOf, groundExtraction, batchByChars, windowAround, domainMatchesName } from './extract.js';
import type { EvidenceItem } from '../store/db.js';

const item = (text: string, url = 'https://example.com/post'): EvidenceItem =>
  ({ source: 'google', ref: url, url, text, signal: null });

test('company keys collapse case, spacing and a trailing TLD', () => {
  assert.equal(companyKey('AiSensy'), 'aisensy');
  assert.equal(companyKey('aisensy.com'), 'aisensy');
  assert.equal(companyKey('Double Tick'), 'doubletick');
  assert.equal(companyKey('Gallabox.co.in'), 'gallabox');
});

test('hostOf strips www and rejects non-URLs', () => {
  assert.equal(hostOf('https://www.wati.io/pricing'), 'wati.io');
  assert.equal(hostOf('not a url'), null);
});

test('a name must appear in the item; platforms are never prospects', () => {
  const items = [item('Top picks: AiSensy and Interakt, both built on WhatsApp by Meta. See aisensy.com')];
  const out = groundExtraction(items, [{ id: '0', companies: [
    { name: 'AiSensy', domain: 'aisensy.com', context: 'Top picks: AiSensy and Interakt' },
    { name: 'Interakt', domain: 'interakt.shop', context: 'made up words' },
    { name: 'Wati', domain: null, context: 'x' },
    { name: 'WhatsApp', domain: null, context: 'x' },
    { name: 'aisensy', domain: null, context: 'dup' },
  ] }]);
  assert.deepEqual(out.map((c) => [c.key, c.domain]), [['aisensy', 'aisensy.com'], ['interakt', null]]);
  assert.equal(out[0]!.snippet, 'Top picks: AiSensy and Interakt');
  assert.match(out[1]!.snippet, /Interakt/);
});

test('the result host counts as a visible domain', () => {
  const out = groundExtraction([item('Gallabox — WhatsApp CRM', 'https://gallabox.com/')], [
    { id: '0', companies: [{ name: 'Gallabox', domain: 'gallabox.com', context: 'Gallabox — WhatsApp CRM' }] },
  ]);
  assert.equal(out[0]!.domain, 'gallabox.com');
});

test('results for unknown item ids are ignored', () => {
  assert.equal(groundExtraction([item('AiSensy')], [{ id: '7', companies: [{ name: 'AiSensy', domain: null, context: '' }] }]).length, 0);
});

test('windowAround returns verbatim text near the name', () => {
  assert.equal(windowAround('aaa Wati bbb', 'wati', 4), 'aaa Wati bbb');
});

test('batches respect both the character and the item budget', () => {
  const items = Array.from({ length: 5 }, (_, i) => item('x'.repeat(100), `https://e.com/${i}`));
  assert.equal(batchByChars(items, 250).length, 3);
  assert.equal(batchByChars(items, 10_000, 2).length, 3);
});

test('a domain must resemble the name, not just be visible', () => {
  assert.ok(domainMatchesName('kraya-ai.com', 'Kraya AI'));
  assert.ok(domainMatchesName('kraya-ai.com', 'Kraya'));
  assert.ok(domainMatchesName('wati.io', 'Wati'));
  assert.ok(!domainMatchesName('kraya-ai.com', 'AiSensy'));
  assert.ok(!domainMatchesName('imbibe.in', 'ItTalk'));
  const out = groundExtraction([item('Top 10: AiSensy, Wati', 'https://kraya-ai.com/blog/top-10')], [
    { id: '0', companies: [{ name: 'AiSensy', domain: 'kraya-ai.com', context: 'x' }] },
  ]);
  assert.equal(out[0]!.domain, null);
});
