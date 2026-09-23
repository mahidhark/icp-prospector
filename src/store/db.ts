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
  source: 'google' | 'reddit';
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
