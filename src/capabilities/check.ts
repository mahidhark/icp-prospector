/**
 * Capability checks: how much of what we sell does a prospect already have?
 *
 * Measured 2026-09-23: the top of the prospect list was the biggest, best
 * documented providers, several shipping their own AI agents and workflow
 * builders. A yes/no check then said 71 of 92 had "AI agents", because a
 * tagline counted. So each capability is a scale, and the judge must place a
 * company on the highest level a snippet actually shows, quoting it verbatim.
 * No quote, no level: the answer is "unknown".
 */
import type { Capability, Icp } from '../icp/schema.js';
import type { SerpHit } from '../sources/google.js';

export const UNKNOWN = 'unknown';

export interface CapabilityQuery {
  key: string;
  name: string;
  capability: string;
  query: string;
}

export function planCapabilityQueries(companies: Array<{ key: string; name: string }>, caps: Capability[]): CapabilityQuery[] {
  return companies.flatMap((c) => caps.flatMap((cap) => cap.queries.map((q) => ({
    key: c.key,
    name: c.name,
    capability: cap.id,
    query: q.replaceAll('{name}', c.name.replace(/"/g, '')),
  }))));
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Only results that name the company are evidence about it. */
export function hitsAbout<T extends Pick<SerpHit, 'title' | 'description'>>(name: string, hits: T[]): T[] {
  const n = normalise(name);
  return hits.filter((h) => normalise(`${h.title} ${h.description}`).includes(n));
}

export interface Snippet { url: string; title: string; description: string }

export interface CompanyCapabilityInput {
  key: string;
  name: string;
  domain: string | null;
  snippets: Snippet[];
}

export function judgeSystem(icp: Icp): string {
  const caps = icp.capabilities.map((c) => [
    `${c.id}: ${c.description}`,
    ...c.levels.map((l, i) => `  ${i}. ${l.id}: ${l.description}`),
  ].join('\n')).join('\n\n');
  return `You place companies on capability scales, from search-result snippets only. Do not use outside knowledge.

${caps}

For each company and each scale:
- level: the HIGHEST level a snippet clearly shows for this company itself, or "${UNKNOWN}" if no snippet speaks to it. Marketing language ("AI-first", "AI-powered", "smart") shows only that the company claims AI; it does not show a product. A product or feature needs a snippet describing what customers can build, deploy or use.
- quote: 10 to 200 characters copied EXACTLY from the snippet that shows that level. Null for "${UNKNOWN}".
- snippet: the index of that snippet. Null for "${UNKNOWN}".

A snippet about a different company, or a listicle describing the category, is not evidence about this company. Snippets from the company's own domain are the strongest evidence.`;
}

export function judgeUser(companies: CompanyCapabilityInput[]): string {
  return companies.map((c) => {
    const lines = c.snippets.map((s, i) => `  [${i}] ${s.title} — ${s.description} (${s.url})`);
    return `<company key="${c.key}" name="${c.name}" domain="${c.domain ?? ''}">\n${lines.join('\n') || '  (no snippets)'}\n</company>`;
  }).join('\n\n');
}

export function judgeSchema(icp: Icp) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['companies'],
    properties: {
      companies: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'capabilities'],
          properties: {
            key: { type: 'string' },
            capabilities: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'level', 'quote', 'snippet'],
                properties: {
                  id: { type: 'string', enum: icp.capabilities.map((c) => c.id) },
                  level: { type: 'string', enum: [...new Set([...icp.capabilities.flatMap((c) => c.levels.map((l) => l.id)), UNKNOWN])] },
                  quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  snippet: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                },
              },
            },
          },
        },
      },
    },
  };
}

export interface JudgeResult {
  key: string;
  capabilities: Array<{ id: string; level: string; quote: string | null; snippet: number | null }>;
}

export interface CapabilityRow {
  key: string;
  capability: string;
  /** A level id from the ICP, or "unknown". Stored in the `status` column. */
  status: string;
  quote: string | null;
  url: string | null;
}

/**
 * Keeps a level only when it belongs to that scale and its quote is verbatim
 * in the snippet it names; otherwise the answer is unknown. Every requested
 * scale gets a row, so a company is never re-judged for one the model skipped.
 */
export function groundJudgement(companies: CompanyCapabilityInput[], results: JudgeResult[], icp: Icp): CapabilityRow[] {
  const byKey = new Map(companies.map((c) => [c.key, c]));
  const levels = new Map(icp.capabilities.map((c) => [c.id, new Set(c.levels.map((l) => l.id))]));
  const out = new Map<string, CapabilityRow>();
  for (const c of companies) {
    for (const cap of icp.capabilities) {
      out.set(`${c.key}|${cap.id}`, { key: c.key, capability: cap.id, status: UNKNOWN, quote: null, url: null });
    }
  }
  for (const r of results) {
    const company = byKey.get(r.key);
    if (!company) continue;
    for (const a of r.capabilities) {
      const slot = `${r.key}|${a.id}`;
      if (!out.has(slot) || a.level === UNKNOWN || !levels.get(a.id)?.has(a.level)) continue;
      const snip = a.snippet == null ? undefined : company.snippets[a.snippet];
      const q = a.quote?.trim() ?? '';
      if (!snip || q.length < 10 || !normalise(`${snip.title} ${snip.description}`).includes(normalise(q))) continue;
      out.set(slot, { key: r.key, capability: a.id, status: a.level, quote: q, url: snip.url });
    }
  }
  return [...out.values()];
}
