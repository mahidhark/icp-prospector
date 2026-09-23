/**
 * SQLite state. Makes discovery idempotent (a re-run adds only what is new)
 * and keeps every paid call on record so `status` can say what was spent.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from '../config.js';
import type { Mention } from '../sources/types.js';

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
