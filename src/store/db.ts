/**
 * SQLite state. Makes discovery idempotent (a re-run adds only what is new)
 * and keeps every paid call on record so `status` can say what was spent.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from '../config.js';
import type { Mention } from '../sources/types.js';
import type { SerpHit } from '../sources/google.js';

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mentions (
    icp          TEXT NOT NULL,
    source       TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    kind         TEXT NOT NULL,
    url          TEXT NOT NULL,
    community    TEXT,
    author       TEXT,
    title        TEXT,
    body         TEXT NOT NULL,
    created_at   TEXT,
    query        TEXT,
    fetched_at   TEXT NOT NULL,
    PRIMARY KEY (icp, source, external_id)
  );
  CREATE TABLE IF NOT EXISTS observations (
    icp          TEXT NOT NULL,
    source       TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    relevant     INTEGER NOT NULL,
    speaker      TEXT,
    pain         TEXT,
    quote        TEXT,
    hypotheses   TEXT,
    model        TEXT NOT NULL,
    observed_at  TEXT NOT NULL,
    PRIMARY KEY (icp, source, external_id)
  );
  CREATE TABLE IF NOT EXISTS serp_results (
    icp          TEXT NOT NULL,
    query        TEXT NOT NULL,
    url          TEXT NOT NULL,
    signal       TEXT,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL,
    position     INTEGER,
    content      TEXT,
    fetched_at   TEXT NOT NULL,
    PRIMARY KEY (icp, query, url)
  );
  -- One row per company per ICP. key = normalised brand name.
  CREATE TABLE IF NOT EXISTS companies (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    name         TEXT NOT NULL,
    domain       TEXT,
    first_seen   TEXT NOT NULL,
    PRIMARY KEY (icp, key)
  );
  -- Why we believe a company exists and what it does: a source item that named it.
  CREATE TABLE IF NOT EXISTS company_evidence (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    source       TEXT NOT NULL,
    ref          TEXT NOT NULL,
    url          TEXT NOT NULL,
    snippet      TEXT NOT NULL,
    signal       TEXT,
    PRIMARY KEY (icp, key, source, ref)
  );
  -- Which source items have been through extraction, so a re-run skips them.
  CREATE TABLE IF NOT EXISTS extracted (
    icp          TEXT NOT NULL,
    source       TEXT NOT NULL,
    ref          TEXT NOT NULL,
    model        TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, source, ref)
  );
  CREATE TABLE IF NOT EXISTS qualifications (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    fit          TEXT NOT NULL,
    segment      TEXT,
    in_geography TEXT NOT NULL,
    reason       TEXT NOT NULL,
    evidence_n   INTEGER NOT NULL,
    model        TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, key)
  );
  -- Per-company marketplace checks, so a company is never searched twice for one signal.
  CREATE TABLE IF NOT EXISTS signal_checks (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    signal       TEXT NOT NULL,
    confirmed    INTEGER NOT NULL,
    url          TEXT,
    query        TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, key, signal)
  );
  -- The LinkedIn company page matched to a prospect, or a recorded miss (linkedin_url NULL).
  CREATE TABLE IF NOT EXISTS linkedin_companies (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    linkedin_url TEXT,
    name         TEXT,
    website      TEXT,
    employees    INTEGER,
    hq           TEXT,
    matched_by   TEXT,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, key)
  );
  -- Chosen contacts. Personal data: stays in the local DB and gitignored out/.
  CREATE TABLE IF NOT EXISTS contacts (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    profile_url  TEXT NOT NULL,
    name         TEXT NOT NULL,
    position     TEXT NOT NULL,
    headline     TEXT,
    location     TEXT,
    emails       TEXT,
    why          TEXT NOT NULL,
    source       TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, key, profile_url)
  );
  -- Everyone a people search returned, normalised, so picking rules can be
  -- re-applied without paying to search again.
  CREATE TABLE IF NOT EXISTS people (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    profile_url  TEXT NOT NULL,
    person       TEXT NOT NULL,
    source       TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, key, profile_url)
  );
  -- Which companies' people search has run, including the ones that found nobody.
  CREATE TABLE IF NOT EXISTS people_searched (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    found        INTEGER NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, key)
  );
  CREATE TABLE IF NOT EXISTS person_posts (
    profile_url  TEXT NOT NULL,
    post_url     TEXT NOT NULL,
    posted_at    TEXT,
    text         TEXT NOT NULL,
    PRIMARY KEY (profile_url, post_url)
  );
  CREATE TABLE IF NOT EXISTS posts_fetched (
    profile_url  TEXT PRIMARY KEY,
    n            INTEGER NOT NULL,
    at           TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contact_signals (
    icp          TEXT NOT NULL,
    profile_url  TEXT NOT NULL,
    signals      TEXT NOT NULL,
    opener       TEXT,
    quote        TEXT,
    post_url     TEXT,
    model        TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, profile_url)
  );
  -- Google results for capability queries, and which (company, capability) pairs were searched.
  CREATE TABLE IF NOT EXISTS capability_hits (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    capability   TEXT NOT NULL,
    url          TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL,
    PRIMARY KEY (icp, key, capability, url)
  );
  CREATE TABLE IF NOT EXISTS capability_searched (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    capability   TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, key, capability)
  );
  -- Which capability queries have run for a company, by query text, so a
  -- scale that reuses an earlier query does not pay for it again.
  CREATE TABLE IF NOT EXISTS capability_queries_done (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    query        TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, key, query)
  );
  CREATE TABLE IF NOT EXISTS capabilities (
    icp          TEXT NOT NULL,
    key          TEXT NOT NULL,
    capability   TEXT NOT NULL,
    status       TEXT NOT NULL,
    quote        TEXT,
    url          TEXT,
    model        TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (icp, key, capability)
  );
  CREATE TABLE IF NOT EXISTS spend (
    at      TEXT NOT NULL,
    icp     TEXT NOT NULL,
    kind    TEXT NOT NULL,
    what    TEXT NOT NULL,
    usd     REAL NOT NULL,
    note    TEXT
  );
  CREATE TABLE IF NOT EXISTS model_calls (
    at             TEXT NOT NULL,
    icp            TEXT NOT NULL,
    task           TEXT NOT NULL,
    model          TEXT NOT NULL,
    input_tokens   INTEGER,
    output_tokens  INTEGER
  );
`;

export type Db = Database.Database;

export function openDb(path = DB_PATH): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

/** Inserts a mention unless it is already stored. Returns true when it was new. */
export function upsertMention(db: Db, icp: string, m: Mention): boolean {
  const res = db.prepare(
    `INSERT OR IGNORE INTO mentions
       (icp, source, external_id, kind, url, community, author, title, body, created_at, query, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    icp, m.source, m.externalId, m.kind, m.url, m.community, m.author, m.title,
    m.body, m.createdAt, m.query, new Date().toISOString(),
  );
  return res.changes > 0;
}

export function recordSpend(db: Db, icp: string, kind: string, what: string, usd: number, note?: string): void {
  db.prepare('INSERT INTO spend (at, icp, kind, what, usd, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), icp, kind, what, usd, note ?? null);
}

export function recordModelCall(
  db: Db, icp: string, task: string, model: string,
  inputTokens: number | null, outputTokens: number | null,
): void {
  db.prepare('INSERT INTO model_calls (at, icp, task, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), icp, task, model, inputTokens, outputTokens);
}

export interface MentionRow {
  icp: string; source: string; external_id: string; kind: string; url: string;
  community: string | null; author: string | null; title: string | null; body: string;
  created_at: string | null; query: string | null;
}

export interface ObservationRow {
  source: string; external_id: string; relevant: number; speaker: string | null;
  pain: string | null; quote: string | null; hypotheses: string | null;
}

export function mentionsFor(db: Db, icp: string): MentionRow[] {
  return db.prepare('SELECT * FROM mentions WHERE icp = ? ORDER BY created_at DESC').all(icp) as MentionRow[];
}

/** Mentions with no observation yet — the only ones the themes pass spends on. */
export function unobservedMentions(db: Db, icp: string): MentionRow[] {
  return db.prepare(
    `SELECT m.* FROM mentions m
       LEFT JOIN observations o
         ON o.icp = m.icp AND o.source = m.source AND o.external_id = m.external_id
      WHERE m.icp = ? AND o.external_id IS NULL
      ORDER BY m.created_at DESC`,
  ).all(icp) as MentionRow[];
}

export function saveObservation(
  db: Db, icp: string, o: ObservationRow, model: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO observations
       (icp, source, external_id, relevant, speaker, pain, quote, hypotheses, model, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(icp, o.source, o.external_id, o.relevant, o.speaker, o.pain, o.quote, o.hypotheses, model, new Date().toISOString());
}

export function observationsFor(db: Db, icp: string): ObservationRow[] {
  return db.prepare('SELECT * FROM observations WHERE icp = ?').all(icp) as ObservationRow[];
}

// ---------- company sources ----------


export function upsertSerpHit(db: Db, icp: string, h: SerpHit): boolean {
  const res = db.prepare(
    `INSERT INTO serp_results (icp, query, url, signal, title, description, position, content, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (icp, query, url) DO UPDATE SET
       content = COALESCE(excluded.content, serp_results.content)`,
  ).run(icp, h.query, h.url, h.signal, h.title, h.description, h.position, h.content, new Date().toISOString());
  return res.changes > 0;
}

export interface SerpRow {
  query: string; url: string; signal: string | null; title: string;
  description: string; position: number | null; content: string | null;
}

/** A source item that may name companies: a search result or a relevant Reddit post. */
export interface EvidenceItem {
  /** `verify` = a per-company signal check, which confirms a listing but says nothing about fit. */
  source: 'google' | 'reddit' | 'verify';
  /** Stable id within the source. */
  ref: string;
  url: string;
  text: string;
  signal: string | null;
}

/**
 * Items not yet run through extraction. Reddit contributes only posts the
 * themes pass marked relevant — the rest are noise by construction.
 */
export function unextractedItems(db: Db, icp: string): EvidenceItem[] {
  const serp = db.prepare(
    `SELECT s.* FROM serp_results s
       LEFT JOIN extracted e ON e.icp = s.icp AND e.source = 'google' AND e.ref = s.query || ' ' || s.url
      WHERE s.icp = ? AND e.ref IS NULL`,
  ).all(icp) as SerpRow[];
  const reddit = db.prepare(
    `SELECT m.* FROM mentions m
       JOIN observations o ON o.icp = m.icp AND o.source = m.source AND o.external_id = m.external_id
       LEFT JOIN extracted e ON e.icp = m.icp AND e.source = 'reddit' AND e.ref = m.external_id
      WHERE m.icp = ? AND o.relevant = 1 AND e.ref IS NULL`,
  ).all(icp) as MentionRow[];

  return [
    ...serp.map((s): EvidenceItem => ({
      source: 'google',
      ref: `${s.query} ${s.url}`,
      url: s.url,
      text: [s.title, s.description, s.content].filter(Boolean).join('\n'),
      signal: s.signal,
    })),
    ...reddit.map((m): EvidenceItem => ({
      source: 'reddit',
      ref: m.external_id,
      url: m.url,
      text: [m.title, m.body].filter(Boolean).join('\n'),
      signal: null,
    })),
  ];
}

export function markExtracted(db: Db, icp: string, item: Pick<EvidenceItem, 'source' | 'ref'>, model: string): void {
  db.prepare('INSERT OR REPLACE INTO extracted (icp, source, ref, model, at) VALUES (?, ?, ?, ?, ?)')
    .run(icp, item.source, item.ref, model, new Date().toISOString());
}

export function upsertCompany(db: Db, icp: string, key: string, name: string, domain: string | null): void {
  db.prepare(
    `INSERT INTO companies (icp, key, name, domain, first_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (icp, key) DO UPDATE SET domain = COALESCE(companies.domain, excluded.domain)`,
  ).run(icp, key, name, domain, new Date().toISOString());
}

export function addEvidence(
  db: Db, icp: string, key: string, item: EvidenceItem, snippet: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO company_evidence (icp, key, source, ref, url, snippet, signal)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(icp, key, item.source, item.ref, item.url, snippet, item.signal);
}

export interface CompanyRow { key: string; name: string; domain: string | null }
export interface EvidenceRow { key: string; source: string; ref: string; url: string; snippet: string; signal: string | null }
export interface QualificationRow {
  key: string; fit: string; segment: string | null; in_geography: string; reason: string; evidence_n: number;
}

export function companiesFor(db: Db, icp: string): CompanyRow[] {
  return db.prepare('SELECT key, name, domain FROM companies WHERE icp = ? ORDER BY key').all(icp) as CompanyRow[];
}

export function evidenceFor(db: Db, icp: string): EvidenceRow[] {
  return db.prepare('SELECT key, source, ref, url, snippet, signal FROM company_evidence WHERE icp = ?').all(icp) as EvidenceRow[];
}

export function qualificationsFor(db: Db, icp: string): QualificationRow[] {
  return db.prepare(
    'SELECT key, fit, segment, in_geography, reason, evidence_n FROM qualifications WHERE icp = ?',
  ).all(icp) as QualificationRow[];
}

export function saveQualification(db: Db, icp: string, q: QualificationRow, model: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO qualifications (icp, key, fit, segment, in_geography, reason, evidence_n, model, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(icp, q.key, q.fit, q.segment, q.in_geography, q.reason, q.evidence_n, model, new Date().toISOString());
}

/**
 * Clears domains that fail `matches` and merges companies left sharing a
 * domain into the one with the most evidence. Idempotent; runs every time the
 * companies stage does, so rows stored before a rule changed are repaired too.
 * Returns how many domains were cleared and companies merged.
 */
export function repairCompanies(
  db: Db, icp: string, matches: (domain: string, name: string) => boolean,
): { cleared: number; merged: number } {
  let cleared = 0;
  let merged = 0;
  const tx = db.transaction(() => {
    for (const c of companiesFor(db, icp)) {
      if (c.domain && !matches(c.domain, c.name)) {
        db.prepare('UPDATE companies SET domain = NULL WHERE icp = ? AND key = ?').run(icp, c.key);
        cleared++;
      }
    }
    const dupes = db.prepare(
      `SELECT c.domain, c.key, (SELECT COUNT(*) FROM company_evidence e WHERE e.icp = c.icp AND e.key = c.key) AS n
         FROM companies c
        WHERE c.icp = ? AND c.domain IN (
          SELECT domain FROM companies WHERE icp = ? AND domain IS NOT NULL GROUP BY domain HAVING COUNT(*) > 1)
        ORDER BY c.domain, n DESC, c.key`,
    ).all(icp, icp) as Array<{ domain: string; key: string; n: number }>;
    const keeper = new Map<string, string>();
    for (const d of dupes) {
      const keep = keeper.get(d.domain);
      if (!keep) { keeper.set(d.domain, d.key); continue; }
      db.prepare(
        `INSERT OR IGNORE INTO company_evidence (icp, key, source, ref, url, snippet, signal)
         SELECT icp, ?, source, ref, url, snippet, signal FROM company_evidence WHERE icp = ? AND key = ?`,
      ).run(keep, icp, d.key);
      db.prepare('DELETE FROM company_evidence WHERE icp = ? AND key = ?').run(icp, d.key);
      db.prepare('DELETE FROM qualifications WHERE icp = ? AND key = ?').run(icp, d.key);
      db.prepare('DELETE FROM companies WHERE icp = ? AND key = ?').run(icp, d.key);
      merged++;
    }
  });
  tx();
  return { cleared, merged };
}

export function checkedSignals(db: Db, icp: string): Set<string> {
  const rows = db.prepare('SELECT key, signal FROM signal_checks WHERE icp = ?').all(icp) as Array<{ key: string; signal: string }>;
  return new Set(rows.map((r) => `${r.key}|${r.signal}`));
}

export function saveSignalCheck(
  db: Db, icp: string, key: string, signal: string, confirmed: boolean, url: string | null, query: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO signal_checks (icp, key, signal, confirmed, url, query, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(icp, key, signal, confirmed ? 1 : 0, url, query, new Date().toISOString());
}

// ---------- contacts ----------

export interface LinkedinCompanyRow {
  key: string; linkedin_url: string | null; name: string | null; website: string | null;
  employees: number | null; hq: string | null; matched_by: string | null;
}

export function linkedinCompaniesFor(db: Db, icp: string): Map<string, LinkedinCompanyRow> {
  const rows = db.prepare('SELECT key, linkedin_url, name, website, employees, hq, matched_by FROM linkedin_companies WHERE icp = ?').all(icp) as LinkedinCompanyRow[];
  return new Map(rows.map((r) => [r.key, r]));
}

export function saveLinkedinCompany(db: Db, icp: string, r: LinkedinCompanyRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO linkedin_companies (icp, key, linkedin_url, name, website, employees, hq, matched_by, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(icp, r.key, r.linkedin_url, r.name, r.website, r.employees, r.hq, r.matched_by, new Date().toISOString());
}

export interface ContactRow {
  key: string; profile_url: string; name: string; position: string; headline: string | null;
  location: string | null; emails: string | null; why: string; source: string;
}

export function saveContact(db: Db, icp: string, c: ContactRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO contacts (icp, key, profile_url, name, position, headline, location, emails, why, source, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(icp, c.key, c.profile_url, c.name, c.position, c.headline, c.location, c.emails, c.why, c.source, new Date().toISOString());
}

export function savePeople(db: Db, icp: string, key: string, people: Array<{ profileUrl: string }>, source: string): void {
  const tx = db.transaction(() => {
    for (const p of people) {
      if (!p.profileUrl) continue;
      db.prepare('INSERT OR REPLACE INTO people (icp, key, profile_url, person, source, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(icp, key, p.profileUrl, JSON.stringify(p), source, new Date().toISOString());
    }
  });
  tx();
}

export function peopleFor<T>(db: Db, icp: string, key: string): Array<{ person: T; source: string }> {
  return (db.prepare('SELECT person, source FROM people WHERE icp = ? AND key = ?').all(icp, key) as Array<{ person: string; source: string }>)
    .map((r) => ({ person: JSON.parse(r.person) as T, source: r.source }));
}

/** Replaces a company's chosen contacts: picking is re-derived from stored people every run. */
export function replaceContacts(db: Db, icp: string, key: string, rows: ContactRow[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM contacts WHERE icp = ? AND key = ?').run(icp, key);
    for (const r of rows) saveContact(db, icp, r);
  });
  tx();
}

export function contactsFor(db: Db, icp: string): ContactRow[] {
  return db.prepare('SELECT key, profile_url, name, position, headline, location, emails, why, source FROM contacts WHERE icp = ?').all(icp) as ContactRow[];
}

export function peopleSearched(db: Db, icp: string): Set<string> {
  return new Set((db.prepare('SELECT key FROM people_searched WHERE icp = ?').all(icp) as Array<{ key: string }>).map((r) => r.key));
}

export function markPeopleSearched(db: Db, icp: string, key: string, found: number): void {
  db.prepare('INSERT OR REPLACE INTO people_searched (icp, key, found, at) VALUES (?, ?, ?, ?)')
    .run(icp, key, found, new Date().toISOString());
}

export function postsFetched(db: Db): Set<string> {
  return new Set((db.prepare('SELECT profile_url FROM posts_fetched').all() as Array<{ profile_url: string }>).map((r) => r.profile_url));
}

export function savePosts(db: Db, profileUrl: string, posts: Array<{ postUrl: string; postedAt: string | null; text: string }>): void {
  const tx = db.transaction(() => {
    for (const p of posts) {
      db.prepare('INSERT OR IGNORE INTO person_posts (profile_url, post_url, posted_at, text) VALUES (?, ?, ?, ?)')
        .run(profileUrl, p.postUrl, p.postedAt, p.text);
    }
    db.prepare('INSERT OR REPLACE INTO posts_fetched (profile_url, n, at) VALUES (?, ?, ?)')
      .run(profileUrl, posts.length, new Date().toISOString());
  });
  tx();
}

export function postsFor(db: Db, profileUrl: string): Array<{ postUrl: string; postedAt: string | null; text: string; profileUrl: string }> {
  return (db.prepare('SELECT post_url, posted_at, text FROM person_posts WHERE profile_url = ? ORDER BY posted_at DESC').all(profileUrl) as Array<{ post_url: string; posted_at: string | null; text: string }>)
    .map((r) => ({ profileUrl, postUrl: r.post_url, postedAt: r.posted_at, text: r.text }));
}

export interface ContactSignalRow { profile_url: string; signals: string; opener: string | null; quote: string | null; post_url: string | null }

export function contactSignalsFor(db: Db, icp: string): Map<string, ContactSignalRow> {
  const rows = db.prepare('SELECT profile_url, signals, opener, quote, post_url FROM contact_signals WHERE icp = ?').all(icp) as ContactSignalRow[];
  return new Map(rows.map((r) => [r.profile_url, r]));
}

export function saveContactSignals(db: Db, icp: string, r: ContactSignalRow, model: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO contact_signals (icp, profile_url, signals, opener, quote, post_url, model, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(icp, r.profile_url, r.signals, r.opener, r.quote, r.post_url, model, new Date().toISOString());
}

// ---------- capabilities ----------

/** `key|query` for every capability query already run. */
export function capabilityQueriesDone(db: Db, icp: string): Set<string> {
  const rows = db.prepare('SELECT key, query FROM capability_queries_done WHERE icp = ?').all(icp) as Array<{ key: string; query: string }>;
  return new Set(rows.map((r) => `${r.key}|${r.query}`));
}

export function saveCapabilityHits(
  db: Db, icp: string, key: string, capability: string, query: string,
  hits: Array<{ url: string; title: string; description: string }>,
): void {
  const tx = db.transaction(() => {
    for (const h of hits) {
      db.prepare('INSERT OR IGNORE INTO capability_hits (icp, key, capability, url, title, description) VALUES (?, ?, ?, ?, ?, ?)')
        .run(icp, key, capability, h.url, h.title, h.description);
    }
    db.prepare('INSERT OR REPLACE INTO capability_queries_done (icp, key, query, at) VALUES (?, ?, ?, ?)')
      .run(icp, key, query, new Date().toISOString());
  });
  tx();
}

/** Every snippet gathered for a company, across its capability searches, deduped by URL. */
export function capabilitySnippets(db: Db, icp: string, key: string): Array<{ url: string; title: string; description: string }> {
  return db.prepare(
    'SELECT url, MIN(title) AS title, MIN(description) AS description FROM capability_hits WHERE icp = ? AND key = ? GROUP BY url ORDER BY url',
  ).all(icp, key) as Array<{ url: string; title: string; description: string }>;
}

export interface CapabilityDbRow { key: string; capability: string; status: string; quote: string | null; url: string | null }

export function capabilitiesFor(db: Db, icp: string): CapabilityDbRow[] {
  return db.prepare('SELECT key, capability, status, quote, url FROM capabilities WHERE icp = ?').all(icp) as CapabilityDbRow[];
}

export function saveCapability(db: Db, icp: string, r: CapabilityDbRow, model: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO capabilities (icp, key, capability, status, quote, url, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(icp, r.key, r.capability, r.status, r.quote, r.url, model, new Date().toISOString());
}
