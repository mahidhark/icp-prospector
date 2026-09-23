import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseCompany, normalisePerson, companyOf, isResolvableProfileUrl, normalisePost, normaliseProfileUrl,
  employeesRunInput, employeesRunWorstUsd, postsRunWorstUsd, profileSearchInput,
} from './linkedin.js';
import { pickLinkedinCompany, titleRank, pickContacts } from './pick.js';
import { groundSignals } from './signals.js';
import { parseIcp } from '../icp/load.js';

const co = (o: Partial<ReturnType<typeof normaliseCompany> & object>) => ({
  query: 'AiSensy', name: 'AiSensy', linkedinUrl: 'https://www.linkedin.com/company/aisensy', website: null,
  employees: null, hq: null, hqCountry: null, ...o,
});

test('company items normalise, and need a name and URL', () => {
  const c = normaliseCompany({ originalQuery: { search: 'Wati ' }, name: 'WATI', linkedinUrl: 'https://www.linkedin.com/company/wati-io/',
    website: 'https://www.wati.io', employeeCount: 250, locations: [{ headquarter: true, parsed: { text: 'Bengaluru, India', countryCode: 'in' } }] });
  assert.deepEqual(c, { query: 'Wati', name: 'WATI', linkedinUrl: 'https://www.linkedin.com/company/wati-io', website: 'https://www.wati.io',
    employees: 250, hq: 'Bengaluru, India', hqCountry: 'IN' });
  assert.equal(normaliseCompany({ name: 'x' }), null);
});

test('our company is matched by domain first, then exact name key, never loosely', () => {
  const byDomain = co({ name: 'Wati.io Official', website: 'www.wati.io' });
  assert.equal(pickLinkedinCompany({ key: 'wati', name: 'Wati', domain: 'wati.io' }, [co({ name: 'Wati' }), byDomain])?.matchedBy, 'domain');
  assert.equal(pickLinkedinCompany({ key: 'wati', name: 'Wati', domain: null }, [co({ name: 'WATI' })])?.matchedBy, 'name');
  assert.equal(pickLinkedinCompany({ key: 'wati', name: 'Wati', domain: null }, [co({ name: 'Wati Solutions' })]), null);
});

test('title rank follows the buyer list, on word boundaries', () => {
  const titles = ['Founder', 'CEO', 'CTO', 'Head of Product'];
  assert.equal(titleRank('Co-Founder & CEO', titles), 0);
  assert.equal(titleRank('Chief Executive | CEO', titles), 1);
  assert.equal(titleRank('Director of Sales', titles), -1);
  assert.equal(titleRank('Head of Product, Growth', titles), 3);
  assert.equal(titleRank("Founder's Office Associate", titles), -1);
  assert.equal(titleRank('Manager, Special Projects - Founder’s Office', titles), -1);
});

test('rank uses the position at this company, not the headline', () => {
  const p = { name: 'X', headline: 'ex-Founder of Y', position: 'Sales Manager', companyName: 'AiSensy',
    companyLinkedinUrl: 'https://www.linkedin.com/company/aisensy', profileUrl: 'https://www.linkedin.com/in/x', location: '', emails: [], hiring: false };
  assert.equal(pickContacts([p], ['Founder']).length, 0);
});

const company = { linkedinUrl: 'https://www.linkedin.com/company/aisensy', name: 'AiSensy' };

test('a person keeps only their position at the target company, and clean emails', () => {
  const p = normalisePerson({
    firstName: 'Asha', lastName: 'Rao', linkedinUrl: 'https://www.linkedin.com/in/asharao',
    currentPosition: [
      { position: 'Advisor', companyName: 'Other', companyLinkedinUrl: 'https://linkedin.com/company/other' },
      { position: 'Co-Founder', companyName: 'AiSensy', companyLinkedinUrl: 'https://linkedin.com/company/aisensy/' },
    ],
    emails: ['Asha@AiSensy.com', { email: 'asha@aisensy.com' }, 'not-an-email'],
  }, company);
  assert.equal(p.position, 'Co-Founder');
  assert.deepEqual(p.emails, ['asha@aisensy.com']);
});

test('employee-source positions map by company name when the URL differs', () => {
  const raw = { firstName: 'B', currentPositions: [{ title: 'CTO', companyName: 'AiSensy', current: true }] };
  assert.equal(companyOf(raw, [{ linkedinUrl: 'https://www.linkedin.com/company/x', name: 'Other' }, company])?.name, 'AiSensy');
});

test('contacts: at the company, link opens, buyer title; best title first, email breaks ties', () => {
  const person = (name: string, position: string, url: string, emails: string[] = []) =>
    ({ name, headline: '', position, companyName: 'AiSensy', companyLinkedinUrl: company.linkedinUrl, profileUrl: url, location: '', emails, hiring: false });
  const picked = pickContacts([
    person('Sales', 'Sales Manager', 'https://www.linkedin.com/in/sales'),
    person('CTO1', 'CTO', 'https://www.linkedin.com/in/cto1'),
    person('CTO2', 'CTO', 'https://www.linkedin.com/in/cto2', ['c@a.com']),
    person('Opaque', 'Founder', 'https://www.linkedin.com/in/ACwAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    person('Founder', 'Founder', 'https://www.linkedin.com/in/founder'),
    { ...person('Ex', 'Founder', 'https://www.linkedin.com/in/ex'), position: '' },
  ], ['Founder', 'CEO', 'CTO'], 2);
  assert.deepEqual(picked.map((p) => p.person.name), ['Founder', 'CTO2']);
  assert.match(picked[0]!.why, /Founder \(buyer title #1\)/);
});

test('member-id URLs are not resolvable', () => {
  assert.ok(isResolvableProfileUrl('https://www.linkedin.com/in/asharao'));
  assert.ok(!isResolvableProfileUrl('https://www.linkedin.com/in/ACwAABCDEFGHIJKLMNOPQRSTUV123'));
  assert.ok(!isResolvableProfileUrl('https://www.linkedin.com/company/x'));
});

test('posts map back to the profile they were requested for', () => {
  const p = normalisePost({ content: ' hello ', linkedinUrl: 'https://www.linkedin.com/posts/x', postedAt: { date: '2026-09-01' },
    query: { targetUrl: 'https://in.linkedin.com/in/AshaRao/' } });
  assert.equal(p?.profileUrl, 'https://www.linkedin.com/in/asharao');
  assert.equal(normalisePost({ content: '', linkedinUrl: 'u', query: { targetUrl: 't' } }), null);
  assert.equal(normaliseProfileUrl('http://linkedin.com/in/X/'), 'https://www.linkedin.com/in/x');
});

test('run inputs and worst cases', () => {
  const o = { titles: ['CEO'], perCompany: 5, emails: true };
  assert.equal(employeesRunInput(['a', 'b'], o).profileScraperMode, 'Full + email search ($12 per 1k)');
  assert.equal(employeesRunInput(['a', 'b'], o).maxItems, 10);
  assert.equal(profileSearchInput('a', { ...o, emails: false }).profileScraperMode, 'Full');
  assert.equal(employeesRunWorstUsd(2, o).toFixed(3), (2 * (0.02 + 5 * 0.012)).toFixed(3));
  assert.equal(postsRunWorstUsd(0, { maxPosts: 5 }), 0);
});

const icp = parseIcp(`
name: t
description: a test ICP for unit tests
personSignals:
  - { id: ai-agents, description: agents talk }
sources: {}
`);

test('an opener survives only if its quote is verbatim in the post it names; unknown signals drop', () => {
  const people = [{ id: 'p1', name: 'A', title: 'CEO', company: 'X', posts: [
    { profileUrl: 'p1', postUrl: 'https://li/post/1', postedAt: null, text: 'We just shipped AI agents for our WhatsApp inbox.' },
  ] }, { id: 'p2', name: 'B', title: 'CTO', company: 'X', posts: [
    { profileUrl: 'p2', postUrl: 'https://li/post/2', postedAt: null, text: 'Hiring engineers.' },
  ] }];
  const out = groundSignals(people, [
    { id: 'p1', signals: ['ai-agents', 'made-up'], opener: 'Saw you shipped agents', quote: 'shipped AI agents for our WhatsApp inbox', post: 0 },
    { id: 'p2', signals: [], opener: 'Saw your hiring', quote: 'We are hiring many engineers', post: 0 },
    { id: 'ghost', signals: [], opener: null, quote: null, post: null },
  ], icp);
  assert.deepEqual(out.map((o) => [o.id, o.signals, o.postUrl]), [['p1', ['ai-agents'], 'https://li/post/1'], ['p2', [], null]]);
  assert.equal(out[1]!.opener, null);
});
