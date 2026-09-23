/**
 * Prospect score. Pure, so every point is explainable and the weights are
 * tested. The model's judgement (fit, segment, geography) is an input; the
 * ranking itself is arithmetic.
 */
import type { Icp } from '../icp/schema.js';
import type { CompanyRow, EvidenceRow, QualificationRow } from '../store/db.js';

export const WEIGHTS = {
  fit: { icp: 50, adjacent: 15, not: 0 } as Record<string, number>,
  geography: { yes: 20, unknown: 5, no: 0 } as Record<string, number>,
  /** Each distinct signal (zapier-app, make-app, …) once. */
  perSignal: 5,
  /** Per distinct Reddit post naming the company, capped. */
  perRedditMention: 2,
  redditCap: 10,
  /** Seen in both web search and Reddit: independent sources agree. */
  bothSources: 5,
  /** Per distinct page naming the company beyond the first, capped. */
  perExtraPage: 2,
  pagesCap: 10,
};

export interface Prospect {
  rank: number;
  key: string;
  name: string;
  domain: string | null;
  fit: string;
  segment: string | null;
  inGeography: string;
  score: number;
  signals: string[];
  redditMentions: number;
  evidenceCount: number;
  reason: string;
  evidenceUrls: string[];
  /** e.g. "fit icp 50 + geo yes 20 + zapier_app 5". */
  breakdown: string;
}

export function scoreCompany(
  icp: Icp, c: CompanyRow, q: QualificationRow | undefined, ev: EvidenceRow[],
): Omit<Prospect, 'rank'> {
  const parts: Array<[string, number]> = [];
  const fit = q?.fit ?? 'not';
  const geo = q?.in_geography ?? 'unknown';

  parts.push([`fit ${fit}`, WEIGHTS.fit[fit] ?? 0]);
  parts.push([`geo ${geo}`, WEIGHTS.geography[geo] ?? 0]);

  const seg = q?.segment ? icp.segments.find((s) => s.id === q.segment) : undefined;
  if (seg) parts.push([`segment ${seg.id}`, seg.weight]);

  const signals = [...new Set(ev.map((e) => e.signal).filter((s): s is string => !!s))].sort();
  for (const s of signals) parts.push([s, WEIGHTS.perSignal]);

  const redditMentions = new Set(ev.filter((e) => e.source === 'reddit').map((e) => e.ref)).size;
  if (redditMentions) parts.push([`reddit x${redditMentions}`, Math.min(WEIGHTS.redditCap, redditMentions * WEIGHTS.perRedditMention)]);

  const pages = new Set(ev.map((e) => e.url)).size;
  if (pages > 1) parts.push([`pages x${pages}`, Math.min(WEIGHTS.pagesCap, (pages - 1) * WEIGHTS.perExtraPage)]);

  const sources = new Set(ev.map((e) => e.source));
  if (sources.has('google') && sources.has('reddit')) parts.push(['both sources', WEIGHTS.bothSources]);

  const nonZero = parts.filter(([, n]) => n > 0);
  return {
    key: c.key,
    name: c.name,
    domain: c.domain,
    fit,
    segment: q?.segment ?? null,
    inGeography: geo,
    score: nonZero.reduce((s, [, n]) => s + n, 0),
    signals,
    redditMentions,
    evidenceCount: ev.length,
    reason: q?.reason ?? '(not qualified yet)',
    evidenceUrls: [...new Set(ev.map((e) => e.url))].slice(0, 3),
    breakdown: nonZero.map(([l, n]) => `${l} ${n}`).join(' + '),
  };
}

/** Scores every company and ranks them, best first; ties break on evidence, then name. */
export function rankProspects(
  icp: Icp, companies: CompanyRow[], quals: QualificationRow[], evidence: Map<string, EvidenceRow[]>,
): Prospect[] {
  const qByKey = new Map(quals.map((q) => [q.key, q]));
  return companies
    .map((c) => scoreCompany(icp, c, qByKey.get(c.key), evidence.get(c.key) ?? []))
    .sort((a, b) => b.score - a.score || b.evidenceCount - a.evidenceCount || a.name.localeCompare(b.name))
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_COLUMNS = [
  'rank', 'company', 'domain', 'fit', 'segment', 'in_geography', 'score', 'signals',
  'reddit_mentions', 'evidence_count', 'reason', 'evidence_urls', 'score_breakdown',
] as const;

export function toCsv(prospects: Prospect[]): string {
  const rows = prospects.map((p) => [
    p.rank, p.name, p.domain, p.fit, p.segment, p.inGeography, p.score, p.signals.join(' '),
    p.redditMentions, p.evidenceCount, p.reason, p.evidenceUrls.join(' '), p.breakdown,
  ].map(csvCell).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}
