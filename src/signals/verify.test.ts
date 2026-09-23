import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChecks, hitConfirms, resolveChecks, checksWorstCaseUsd } from './verify.js';

const checks = [
  { signal: 'zapier-app', site: 'zapier.com/apps' },
  { signal: 'make-app', site: 'make.com/en/integrations' },
];

test('one quoted site: query per company per signal', () => {
  const p = planChecks([{ key: 'aisensy', name: 'AiSensy' }, { key: 'x', name: 'Say "Hi"' }], checks);
  assert.equal(p.length, 4);
  assert.equal(p[0]!.query, 'site:zapier.com/apps "AiSensy"');
  assert.equal(p[3]!.query, 'site:make.com/en/integrations "Say Hi"');
});

const zap = planChecks([{ key: 'aisensy', name: 'AiSensy' }], checks)[0]!;
const resp = planChecks([{ key: 'respond', name: 'Respond.io' }], checks)[0]!;

test('a listing page or a pair page naming the company confirms it', () => {
  assert.ok(hitConfirms(zap, { url: 'https://zapier.com/apps/aisensy/integrations', title: 'AiSensy Integrations' }));
  assert.ok(hitConfirms(zap, { url: 'https://zapier.com/apps/google-sheets/integrations/aisensy', title: 'Google Sheets + AiSensy' }));
  assert.ok(hitConfirms(resp, { url: 'https://zapier.com/apps/respondio/integrations', title: 'respond.io Integrations' }));
});

test('the wrong site, the wrong path, or no name does not', () => {
  assert.ok(!hitConfirms(zap, { url: 'https://zapier.com/blog/aisensy-review', title: 'AiSensy review' }));
  assert.ok(!hitConfirms(zap, { url: 'https://aisensy.com/zapier.com/apps', title: 'AiSensy' }));
  assert.ok(!hitConfirms(zap, { url: 'https://zapier.com/apps/whatsapp-business/integrations', title: 'WhatsApp Business' }));
  assert.ok(!hitConfirms(zap, { url: 'not a url', title: 'AiSensy' }));
});

test('each check takes the first confirming hit for its own query only', () => {
  const planned = planChecks([{ key: 'aisensy', name: 'AiSensy' }, { key: 'wati', name: 'Wati' }], [checks[0]!]);
  const hit = (query: string, url: string, title: string) =>
    ({ query, signal: 'zapier-app', url, title, description: '', position: 1, content: null });
  const out = resolveChecks(planned, [
    hit(planned[0]!.query, 'https://zapier.com/apps/whatsapp-business/integrations', 'WhatsApp'),
    hit(planned[0]!.query, 'https://zapier.com/apps/aisensy/integrations', 'AiSensy'),
    hit(planned[0]!.query, 'https://zapier.com/apps/wati/integrations', 'Wati'),
  ]);
  assert.equal(out[0]!.hit?.url, 'https://zapier.com/apps/aisensy/integrations');
  assert.equal(out[1]!.hit, null);
});

test('worst case is one results page per check plus one start fee; zero checks cost nothing', () => {
  assert.equal(checksWorstCaseUsd(0), 0);
  assert.equal(checksWorstCaseUsd(100).toFixed(3), (0.001 + 100 * 0.0045).toFixed(3));
});
