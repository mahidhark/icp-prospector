/**
 * npm run contacts -- --icp <name> [--top 30] [--per-company 2] [--no-emails] [--budget 10] [--dry-run]
 *
 * For the top-ranked ICP companies: find each on LinkedIn, find the buyers
 * there, read their recent posts, tag signals and ground one opener, and write
 * out/<icp>/contacts.csv. Every stage skips work already done, so a re-run with
 * a larger --top only pays for the new companies.
 *
 * Nothing here contacts anyone. The CSV is personal data; it stays in the
 * gitignored out/ folder.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadIcp } from './icp/load.js';
import { Budget, parseBudgetFlag } from './budget.js';
import {
  openDb, companiesFor, qualificationsFor, evidenceFor, recordSpend, recordModelCall,
  linkedinCompaniesFor, saveLinkedinCompany, contactsFor, peopleSearched, markPeopleSearched,
  postsFetched, savePosts, postsFor, contactSignalsFor, saveContactSignals, savePeople, peopleFor, replaceContacts, type Db,
} from './store/db.js';
import { groupEvidence } from './resolve/qualify.js';
import { rankProspects, type Prospect } from './score/score.js';
import { runActor } from './apify/client.js';
import type { Person } from './contacts/linkedin.js';
import {
  LINKEDIN, companyRunInput, companyRunWorstUsd, normaliseCompany, type LinkedinCompanyItem,
  employeesRunInput, employeesRunWorstUsd, profileSearchInput, profileSearchWorstUsd,
  normalisePerson, companyOf, type RawPerson, type PeopleOptions,
  postsRunInput, postsRunWorstUsd, normalisePost, normaliseProfileUrl, type RawPost,
} from './contacts/linkedin.js';
import { pickLinkedinCompany, pickContacts } from './contacts/pick.js';
import { signalsSystem, signalsUser, signalsSchema, groundSignals, type PersonPosts, type SignalsResult } from './contacts/signals.js';
import { anthropicModel } from './ai/anthropic.js';
import { MODEL, OUT_DIR } from './config.js';
import type { Icp } from './icp/schema.js';

const DEFAULT_BUDGET_USD = 10;
const SIGNALS_BATCH = 8;
const MAX_POSTS = 5;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Runs a paid actor call against the budget; returns null (and says why) when it can't. */
async function paid<T>(
  db: Db, icp: string, budget: Budget, actor: string, worst: number, label: string,
  input: Record<string, unknown>, estimate: (items: number) => number,
): Promise<T[] | null> {
  const settle = budget.reserve(worst);
  if (!settle) {
    console.log(`  SKIPPED ${label}: worst case $${worst.toFixed(2)} exceeds remaining $${budget.remainingUsd.toFixed(2)}`);
    return null;
  }
  try {
    const out = await runActor<T>(actor, input, { timeoutSecs: 3600 });
    // Measured 2026-09-23: pay-per-event runs can report ~$0 usage at finish,
    // before their per-item events are billed. Record the larger of Apify's
    // figure and the price table's, so spend is never under-counted.
    const cost = Math.min(worst, Math.max(out.usageUsd ?? 0, estimate(out.items.length)));
    settle(cost);
    recordSpend(db, icp, 'contacts', actor, cost, `${label} run=${out.runId} ${out.status}`);
    console.log(`  ${label}: ${out.items.length} items, $${cost.toFixed(3)} (${out.status})`);
    return out.items;
  } catch (err) {
    settle(0.02);
    recordSpend(db, icp, 'contacts', actor, 0.02, `${label} FAILED`);
    console.log(`  FAILED ${label}: ${(err as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const icpRef = flag(args, '--icp');
  if (!icpRef) throw new Error('usage: npm run contacts -- --icp <name> [--top 30] [--per-company 2] [--no-emails] [--budget 10] [--dry-run]');
  const top = Number(flag(args, '--top') ?? 30);
  const perCompany = Number(flag(args, '--per-company') ?? 2);
  const dryRun = args.includes('--dry-run');
  const budget = new Budget(parseBudgetFlag(args, DEFAULT_BUDGET_USD));
  const icp = loadIcp(icpRef);
  if (!icp.buyerTitles.length) throw new Error(`${icp.name} defines no buyerTitles`);
  // Pull a few more profiles than we keep, so the title ranking has a choice.
  const people: PeopleOptions = { titles: icp.buyerTitles, perCompany: Math.max(perCompany * 3, 5), emails: !args.includes('--no-emails') };

  const db = openDb();
  const evidence = groupEvidence(evidenceFor(db, icp.name));
  const targets = rankProspects(icp, companiesFor(db, icp.name), qualificationsFor(db, icp.name), evidence)
    .filter((p) => p.fit === 'icp').slice(0, top);
  console.log(`contacts: top ${targets.length} ICP companies, up to ${perCompany} people each, emails ${people.emails ? 'on' : 'off'}, budget $${budget.limitUsd.toFixed(2)}`);

  // ---- 1. companies on LinkedIn
  let li = linkedinCompaniesFor(db, icp.name);
  const toResolve = targets.filter((t) => !li.has(t.key));
  const w1 = companyRunWorstUsd(toResolve.length);
  console.log(`resolve: ${toResolve.length} companies to find on LinkedIn (worst $${w1.toFixed(2)})`);
  if (toResolve.length && !dryRun) {
    const items = await paid<LinkedinCompanyItem>(db, icp.name, budget, LINKEDIN.company.actor, w1, 'linkedin-company', companyRunInput(toResolve.map((t) => t.name)),
      (n) => companyRunWorstUsd(n));
    if (items) {
      const found = items.map(normaliseCompany).filter((c): c is NonNullable<typeof c> => !!c);
      for (const t of toResolve) {
        const candidates = found.filter((c) => c.query === t.name);
        const m = pickLinkedinCompany({ key: t.key, name: t.name, domain: t.domain }, candidates);
        saveLinkedinCompany(db, icp.name, m
          ? { key: t.key, linkedin_url: m.company.linkedinUrl, name: m.company.name, website: m.company.website, employees: m.company.employees, hq: m.company.hq, matched_by: m.matchedBy }
          : { key: t.key, linkedin_url: null, name: null, website: null, employees: null, hq: null, matched_by: candidates.length ? 'no-match' : 'not-found' });
      }
    }
    li = linkedinCompaniesFor(db, icp.name);
  }

  // ---- 2. people
  const searched = peopleSearched(db, icp.name);
  const toSearch = targets
    .map((t) => ({ t, row: li.get(t.key) }))
    .filter((x): x is { t: Prospect; row: NonNullable<typeof x.row> & { linkedin_url: string } } => !!x.row?.linkedin_url && !searched.has(x.t.key));
  const w2 = employeesRunWorstUsd(toSearch.length, people);
  console.log(`people: ${toSearch.length} companies to search (worst $${w2.toFixed(2)}, plus profile-search fallback $${profileSearchWorstUsd(people).toFixed(2)} per empty company)`);

  // Store everyone returned, then pick from storage, so a changed picking
  // rule applies to people already paid for.
  const keep = (key: string, raws: RawPerson[], company: { linkedinUrl: string; name: string }, source: string): number => {
    savePeople(db, icp.name, key, raws.map((r) => normalisePerson(r, company)), source);
    return repick(db, icp, key, perCompany);
  };

  if (toSearch.length && !dryRun) {
    const companies = toSearch.map((x) => ({ key: x.t.key, linkedinUrl: x.row.linkedin_url, name: x.row.name ?? x.t.name }));
    const raws = await paid<RawPerson>(db, icp.name, budget, LINKEDIN.employees.actor, w2, 'linkedin-company-employees',
      employeesRunInput(companies.map((c) => c.linkedinUrl), people),
      (n) => companies.length * LINKEDIN.employees.perCompanyStartUsd + n * (people.emails ? LINKEDIN.employees.perProfileUsd.fullEmail : LINKEDIN.employees.perProfileUsd.full));
    const empty: typeof companies = [];
    for (const c of companies) {
      const mine = (raws ?? []).filter((r) => companyOf(r, [c]));
      const n = raws ? keep(c.key, mine, c, 'employees') : 0;
      if (n) markPeopleSearched(db, icp.name, c.key, n);
      else if (raws) empty.push(c);
    }
    // Fallback: an independent source for companies the first found nobody at.
    for (const c of empty) {
      const more = await paid<RawPerson>(db, icp.name, budget, LINKEDIN.profileSearch.actor, profileSearchWorstUsd(people),
        `linkedin-profile-search ${c.name}`, profileSearchInput(c.linkedinUrl, people),
        (n) => LINKEDIN.profileSearch.perSearchPageUsd + n * (people.emails ? LINKEDIN.profileSearch.perProfileUsd.fullEmail : LINKEDIN.profileSearch.perProfileUsd.full));
      if (!more) continue;
      markPeopleSearched(db, icp.name, c.key, keep(c.key, more, c, 'profile-search'));
    }
  }

  // ---- 2b. re-pick every searched company from stored people
  if (!dryRun) for (const t of targets) if (peopleSearched(db, icp.name).has(t.key)) repick(db, icp, t.key, perCompany);

  // ---- 3. posts
  const targetKeys = new Set(targets.map((t) => t.key));
  const contacts = contactsFor(db, icp.name).filter((c) => targetKeys.has(c.key));
  const fetched = postsFetched(db);
  const toRead = [...new Set(contacts.map((c) => c.profile_url))].filter((u) => !fetched.has(u));
  const w3 = postsRunWorstUsd(toRead.length, { maxPosts: MAX_POSTS });
  console.log(`posts: ${toRead.length} people to read (worst $${w3.toFixed(2)})`);
  if (toRead.length && !dryRun) {
    const raw = await paid<RawPost>(db, icp.name, budget, LINKEDIN.posts.actor, w3, 'linkedin-profile-posts', postsRunInput(toRead, { maxPosts: MAX_POSTS }),
      (n) => LINKEDIN.posts.startUsd + n * LINKEDIN.posts.perPostUsd);
    if (raw) {
      const posts = raw.map(normalisePost).filter((p): p is NonNullable<typeof p> => !!p);
      for (const url of toRead) savePosts(db, url, posts.filter((p) => p.profileUrl === url));
    }
  }

  // ---- 4. signals
  if (!dryRun) await tagSignals(db, icp, contacts, targets);

  // ---- 5. csv
  if (!dryRun) writeCsv(db, icp, targets);
  console.log(`spent $${budget.spentUsd.toFixed(3)} of $${budget.limitUsd.toFixed(2)}`);
  db.close();
}

function repick(db: Db, icp: Icp, key: string, perCompany: number): number {
  const stored = peopleFor<Person>(db, icp.name, key);
  // Never re-derive from an empty store: that would erase contacts found
  // before people were stored, with nothing to replace them.
  if (!stored.length) return contactsFor(db, icp.name).filter((c) => c.key === key).length;
  const source = new Map(stored.map((s) => [s.person.profileUrl, s.source]));
  const picked = pickContacts(stored.map((s) => s.person), icp.buyerTitles, perCompany);
  replaceContacts(db, icp.name, key, picked.map((c) => ({
    key, profile_url: normaliseProfileUrl(c.person.profileUrl), name: c.person.name, position: c.person.position,
    headline: c.person.headline || null, location: c.person.location || null,
    emails: c.person.emails.length ? JSON.stringify(c.person.emails) : null, why: c.why,
    source: source.get(c.person.profileUrl) ?? 'unknown',
  })));
  return picked.length;
}

async function tagSignals(db: Db, icp: Icp, contacts: ReturnType<typeof contactsFor>, targets: Prospect[]): Promise<void> {
  const done = contactSignalsFor(db, icp.name);
  const byKey = new Map(targets.map((t) => [t.key, t]));
  const todo: PersonPosts[] = [];
  for (const c of contacts) {
    if (done.has(c.profile_url)) continue;
    const posts = postsFor(db, c.profile_url).slice(0, MAX_POSTS);
    if (!posts.length) {
      // Nothing to read is an answer, and costs nothing to record.
      saveContactSignals(db, icp.name, { profile_url: c.profile_url, signals: '[]', opener: null, quote: null, post_url: null }, 'none');
      continue;
    }
    todo.push({ id: c.profile_url, name: c.name, title: c.position, company: byKey.get(c.key)?.name ?? c.key, posts });
  }
  console.log(`signals: ${todo.length} people with posts to tag`);
  if (!todo.length) return;
  const model = anthropicModel(MODEL);
  for (let i = 0; i < todo.length; i += SIGNALS_BATCH) {
    const batch = todo.slice(i, i + SIGNALS_BATCH);
    const res = await model.parse<{ people: SignalsResult[] }>(signalsSystem(icp), signalsUser(batch), signalsSchema(icp) as Record<string, unknown>, 8000);
    recordModelCall(db, icp.name, 'signals', model.id, res.inputTokens, res.outputTokens);
    const rows = groundSignals(batch, res.value.people, icp);
    for (const r of rows) {
      saveContactSignals(db, icp.name, { profile_url: r.id, signals: JSON.stringify(r.signals), opener: r.opener, quote: r.quote, post_url: r.postUrl }, model.id);
    }
    console.log(`  ${Math.min(i + SIGNALS_BATCH, todo.length)}/${todo.length}: ${rows.filter((r) => r.opener).length} grounded openers`);
  }
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CONTACT_COLUMNS = [
  'company_rank', 'company', 'segment', 'company_score', 'company_signals', 'linkedin_company', 'contact',
  'position', 'linkedin_profile', 'email', 'person_signals', 'recent_posts', 'opener', 'opener_quote', 'opener_post', 'why_this_person',
] as const;

function writeCsv(db: Db, icp: Icp, targets: Prospect[]): void {
  const li = linkedinCompaniesFor(db, icp.name);
  const sig = contactSignalsFor(db, icp.name);
  const byKey = new Map(contactsFor(db, icp.name).reduce((m, c) => m.set(c.key, [...(m.get(c.key) ?? []), c]), new Map<string, ReturnType<typeof contactsFor>>()));
  const lines: string[] = [CONTACT_COLUMNS.join(',')];
  let people = 0;
  let withEmail = 0;
  for (const [i, t] of targets.entries()) {
    const company = li.get(t.key);
    const found = byKey.get(t.key) ?? [];
    const rows = found.length ? found : [null];
    for (const c of rows) {
      const s = c ? sig.get(c.profile_url) : undefined;
      const emails = c?.emails ? (JSON.parse(c.emails) as string[]) : [];
      if (c) people++;
      if (emails.length) withEmail++;
      lines.push([
        i + 1, t.name, t.segment, t.score, t.signals.join(' '), company?.linkedin_url ?? `(${company?.matched_by ?? 'not searched'})`,
        c?.name ?? '(nobody found)', c?.position, c?.profile_url, emails[0], s ? (JSON.parse(s.signals) as string[]).join(' ') : '',
        c ? postsFor(db, c.profile_url).length : '', s?.opener, s?.quote, s?.post_url, c?.why,
      ].map(csvCell).join(','));
    }
  }
  const dir = join(OUT_DIR, icp.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'contacts.csv'), lines.join('\n') + '\n');
  console.log(`wrote ${join(dir, 'contacts.csv')}: ${people} people across ${targets.length} companies, ${withEmail} with an email`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
