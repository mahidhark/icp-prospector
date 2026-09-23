/**
 * Qualification: is this company in the ICP, which segment, which geography?
 *
 * Judged only on the evidence we collected, which the prompt says and the
 * `unknown` option makes possible. A model asked "is Wati Indian?" will answer
 * from memory; asked "does this evidence say so?" it can say it doesn't.
 */
import type { Icp } from '../icp/schema.js';
import type { CompanyRow, EvidenceRow, QualificationRow } from '../store/db.js';

export const FITS = ['icp', 'adjacent', 'not'] as const;
export const GEO = ['yes', 'no', 'unknown'] as const;

const SNIPPETS_PER_COMPANY = 6;

export function qualifySystem(icp: Icp): string {
  const segs = icp.segments.map((s) => `- ${s.id}: ${s.description.trim()}`).join('\n');
  const geo = icp.geography.length ? icp.geography.join(', ') : 'anywhere';
  return `You qualify companies for a B2B prospect list, using ONLY the evidence given for each company. Do not use outside knowledge; if the evidence does not say, answer accordingly.

The target customer (ICP): ${icp.description.trim()}
Target geography: ${geo}

Segments:
${segs || '- (none defined)'}

For each company decide:
- fit: "icp" if the evidence shows it is the kind of company described; "adjacent" if it is in the same market but a different kind of company (an agency, a tool vendor, a reseller, a platform for a different channel); "not" if unrelated or the evidence is too thin to tell what it does.
- segment: the id of the best-matching segment, or null if fit is not "icp" or none match.
- in_geography: "yes" if the evidence shows it is based in or clearly sells into the target geography, "no" if it shows otherwise, "unknown" if the evidence does not say.
- reason: one sentence naming the evidence you relied on.

Return one result per company key, in the order given.`;
}

export function qualifyUser(companies: CompanyRow[], evidence: Map<string, EvidenceRow[]>): string {
  return companies.map((c) => {
    const ev = (evidence.get(c.key) ?? []).slice(0, SNIPPETS_PER_COMPANY);
    const lines = ev.map((e) => `  - [${e.source}${e.signal ? `, ${e.signal}` : ''}] ${e.snippet} (${e.url})`);
    return `<company key="${c.key}" name="${c.name}" domain="${c.domain ?? ''}">\n${lines.join('\n')}\n</company>`;
  }).join('\n\n');
}

export function qualifySchema(icp: Icp) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'fit', 'segment', 'in_geography', 'reason'],
          properties: {
            key: { type: 'string' },
            fit: { type: 'string', enum: [...FITS] },
            // anyOf, not an enum containing null: the API rejects an enum value
            // that does not match every declared type (measured 2026-09-23).
            segment: icp.segments.length
              ? { anyOf: [{ type: 'string', enum: icp.segments.map((s) => s.id) }, { type: 'null' }] }
              : { type: 'null' },
            in_geography: { type: 'string', enum: [...GEO] },
            reason: { type: 'string' },
          },
        },
      },
    },
  };
}

export interface QualifyResult {
  key: string;
  fit: (typeof FITS)[number];
  segment: string | null;
  in_geography: (typeof GEO)[number];
  reason: string;
}

/** Keeps results for companies in the batch; a segment on a non-ICP fit is cleared. */
export function toQualifications(
  batch: CompanyRow[], results: QualifyResult[], evidence: Map<string, EvidenceRow[]>, icp: Icp,
): QualificationRow[] {
  const keys = new Set(batch.map((c) => c.key));
  const segIds = new Set(icp.segments.map((s) => s.id));
  const out: QualificationRow[] = [];
  for (const r of results) {
    if (!keys.has(r.key)) continue;
    keys.delete(r.key);
    out.push({
      key: r.key,
      fit: r.fit,
      segment: r.fit === 'icp' && r.segment && segIds.has(r.segment) ? r.segment : null,
      in_geography: r.in_geography,
      reason: r.reason.trim(),
      evidence_n: evidence.get(r.key)?.length ?? 0,
    });
  }
  return out;
}

export function groupEvidence(rows: EvidenceRow[]): Map<string, EvidenceRow[]> {
  const m = new Map<string, EvidenceRow[]>();
  for (const r of rows) m.set(r.key, [...(m.get(r.key) ?? []), r]);
  // Google before Reddit, and signal-bearing evidence first: most informative first.
  for (const [k, v] of m) {
    m.set(k, v.sort((a, b) => Number(!!b.signal) - Number(!!a.signal) || a.source.localeCompare(b.source)));
  }
  return m;
}
