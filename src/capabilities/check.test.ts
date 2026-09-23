import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCapabilityQueries, hitsAbout, groundJudgement, judgeSchema, judgeSystem } from './check.js';
import { parseIcp } from '../icp/load.js';
import { scoreCompany } from '../score/score.js';

const icp = parseIcp(`
name: t
description: a test ICP for unit tests
capabilities:
  - id: ai-depth
    description: how deep the company's own AI goes
    queries: ['"{name}" AI agent', '"{name}" workflow builder']
    levels:
      - { id: ai-claim, description: tagline only, weight: 5 }
      - { id: chatbot, description: a bot builder, weight: 0 }
      - { id: agent-product, description: a real agent product, weight: -15 }
    unknownWeight: -10
sources: {}
`);

test('every capability query must contain {name}', () => {
  assert.throws(() => parseIcp(`
name: t
description: a test ICP for unit tests
capabilities: [{ id: x-y, description: something here, queries: ['no placeholder'], levels: [{ id: a, description: aaaaa }, { id: b, description: bbbbb }] }]
sources: {}
`), /\{name\}/);
});

test('one query per company per template, name substituted without quotes', () => {
  const q = planCapabilityQueries([{ key: 'wati', name: 'Wati "HK"' }], icp.capabilities);
  assert.deepEqual(q.map((x) => x.query), ['"Wati HK" AI agent', '"Wati HK" workflow builder']);
});

test('only results that name the company count', () => {
  const hits = [{ title: 'Wati AI Agent launch', description: '' }, { title: 'Top 10 AI agents', description: 'for WhatsApp' }];
  assert.equal(hitsAbout('wati', hits).length, 1);
});

const company = { key: 'wati', name: 'Wati', domain: 'wati.io', snippets: [
  { url: 'https://www.wati.io/ai', title: 'Wati AI Agents', description: 'Deploy AI agents that qualify leads and book demos on WhatsApp.' },
] };

test('a level needs a verbatim quote from the named snippet and must belong to the scale', () => {
  const ok = groundJudgement([company], [{ key: 'wati', capabilities: [
    { id: 'ai-depth', level: 'agent-product', quote: 'AI agents that qualify leads and book demos', snippet: 0 },
  ] }], icp);
  assert.deepEqual(ok.map((r) => [r.status, r.url]), [['agent-product', 'https://www.wati.io/ai']]);

  const paraphrase = groundJudgement([company], [{ key: 'wati', capabilities: [
    { id: 'ai-depth', level: 'agent-product', quote: 'agents that book meetings automatically', snippet: 0 },
  ] }], icp);
  assert.equal(paraphrase[0]!.status, 'unknown');

  const offScale = groundJudgement([company], [{ key: 'wati', capabilities: [
    { id: 'ai-depth', level: 'yes', quote: 'AI agents that qualify leads and book demos', snippet: 0 },
  ] }], icp);
  assert.equal(offScale[0]!.status, 'unknown');
});

test('a skipped company still gets an unknown row, so it is not re-judged forever', () => {
  assert.equal(groundJudgement([company], [], icp)[0]!.status, 'unknown');
});

test('schema and prompt carry the scale, lowest to highest', () => {
  const s = judgeSchema(icp) as any;
  assert.deepEqual(s.properties.companies.items.properties.capabilities.items.properties.level.enum, ['ai-claim', 'chatbot', 'agent-product', 'unknown']);
  assert.match(judgeSystem(icp), /0\. ai-claim[\s\S]*2\. agent-product/);
});

test('each level scores its weight, unknown scores unknownWeight, unjudged scores nothing', () => {
  const c = { key: 'wati', name: 'Wati', domain: null };
  const base = scoreCompany(icp, c, undefined, []).score;
  const at = (status: string) => scoreCompany(icp, c, undefined, [], [{ key: 'wati', capability: 'ai-depth', status, quote: null, url: null }]);
  assert.equal(at('agent-product').score, base - 15);
  assert.equal(at('ai-claim').score, base + 5);
  assert.equal(at('chatbot').score, base);
  assert.equal(at('unknown').score, base - 10);
  assert.deepEqual(at('chatbot').capabilities, ['ai-depth:chatbot']);
  assert.match(at('agent-product').breakdown, /ai-depth agent-product -15/);
});
