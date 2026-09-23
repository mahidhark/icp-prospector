import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toQualifications, groupEvidence, qualifySchema } from './qualify.js';
import { parseIcp } from '../icp/load.js';

const icp = parseIcp(`
name: t
description: a test ICP for unit tests
segments:
  - { id: smb-crm, description: small business crm }
sources: {}
`);

test('segment is cleared unless fit is icp, and unknown keys are dropped', () => {
  const evidence = groupEvidence([{ key: 'a', source: 'google', ref: '1', url: 'u', snippet: 's', signal: null }]);
  const rows = toQualifications(
    [{ key: 'a', name: 'A', domain: null }, { key: 'b', name: 'B', domain: null }],
    [
      { key: 'a', fit: 'adjacent', segment: 'smb-crm', in_geography: 'yes', reason: ' r ' },
      { key: 'b', fit: 'icp', segment: 'invented', in_geography: 'unknown', reason: 'r' },
      { key: 'z', fit: 'icp', segment: null, in_geography: 'no', reason: 'r' },
    ], evidence, icp);
  assert.deepEqual(rows.map((r) => [r.key, r.segment, r.evidence_n, r.reason]), [['a', null, 1, 'r'], ['b', null, 0, 'r']]);
});

test('evidence with a signal sorts first', () => {
  const g = groupEvidence([
    { key: 'a', source: 'reddit', ref: '1', url: 'u', snippet: 's', signal: null },
    { key: 'a', source: 'google', ref: '2', url: 'u', snippet: 's', signal: 'zapier-app' },
  ]);
  assert.equal(g.get('a')![0]!.signal, 'zapier-app');
});

test('the schema offers the ICP segments or null, without mixing null into the enum', () => {
  const seg = (qualifySchema(icp).properties.results.items.properties as Record<string, unknown>).segment;
  assert.deepEqual(seg, { anyOf: [{ type: 'string', enum: ['smb-crm'] }, { type: 'null' }] });
});
