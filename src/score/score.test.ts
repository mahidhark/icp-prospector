import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCompany, rankProspects, toCsv } from './score.js';
import { parseIcp } from '../icp/load.js';
import type { EvidenceRow, QualificationRow } from '../store/db.js';

const icp = parseIcp(`
name: t
description: a test ICP for unit tests
segments:
  - { id: smb-crm, description: small business crm, weight: 15 }
sources: {}
`);

const ev = (source: string, ref: string, signal: string | null = null): EvidenceRow =>
  ({ key: 'a', source, ref, url: `https://e.com/${ref}`, snippet: 's', signal });

const q = (fit: string, geo: string, segment: string | null = null): QualificationRow =>
  ({ key: 'a', fit, segment, in_geography: geo, reason: 'r', evidence_n: 1 });

test('score adds fit, geography, segment, each signal once, capped reddit, and both-sources', () => {
  const s = scoreCompany(icp, { key: 'a', name: 'A', domain: null }, q('icp', 'yes', 'smb-crm'), [
    ev('google', 'g1', 'zapier-app'), ev('google', 'g2', 'zapier-app'), ev('google', 'g3', 'make-app'),
    ...Array.from({ length: 9 }, (_, i) => ev('reddit', `r${i}`)),
  ]);
  // 50 + 20 + 15 + 5 + 5 + min(10, 18) + pages min(10, 11*2) + 5
  assert.equal(s.score, 120);
  assert.deepEqual(s.signals, ['make-app', 'zapier-app']);
  assert.equal(s.redditMentions, 9);
  assert.match(s.breakdown, /^fit icp 50 \+ geo yes 20 \+ segment smb-crm 15/);
});

test('an unjudged company scores only on its evidence', () => {
  const s = scoreCompany(icp, { key: 'a', name: 'A', domain: null }, undefined, [ev('google', 'g1')]);
  assert.equal(s.fit, 'not');
  assert.equal(s.score, 5);
});

test('ranking sorts by score, then evidence, then name', () => {
  const ranked = rankProspects(icp,
    [{ key: 'a', name: 'B', domain: null }, { key: 'b', name: 'A', domain: null }],
    [], new Map());
  assert.deepEqual(ranked.map((p) => [p.rank, p.name]), [[1, 'A'], [2, 'B']]);
});

test('csv quotes cells with commas and quotes', () => {
  const [p] = rankProspects(icp, [{ key: 'a', name: 'Acme, "Inc"', domain: null }], [], new Map());
  assert.match(toCsv([p!]).split('\n')[1]!, /^1,"Acme, ""Inc""",/);
});
