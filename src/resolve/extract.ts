/**
 * Company extraction: which companies does a search result or a post name?
 *
 * The model proposes; the code checks. A company is kept only if its name
 * appears in the text it was extracted from, and a domain only if it appears
 * there too or is the host of the result itself. A name the model knows from
 * training but that the source never mentions is exactly the hallucination a
 * prospect list must not contain.
 */
import type { Icp } from '../icp/schema.js';
import type { EvidenceItem } from '../store/db.js';

/** Platforms that appear everywhere in this space and are never prospects. */
export const NEVER_PROSPECTS = new Set([
  'meta', 'facebook', 'whatsapp', 'instagram', 'google', 'zapier', 'make', 'n8n',
  'reddit', 'openai', 'chatgpt', 'microsoft', 'amazon', 'shopify', 'hubspot', 'salesforce',
]);

/** "AiSensy.com", "Interakt " → "aisensy", "interakt". The dedupe key. */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(com|io|ai|in|co|app|net|org)(\.[a-z]{2})?$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** "https://www.aisensy.com/pricing" → "aisensy.com". Null for non-URLs. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

/**
 * Whether a domain plausibly belongs to a company name: "kraya-ai.com" to
 * "Kraya AI", "wati.io" to "Wati", but not "kraya-ai.com" to "AiSensy".
 *
 * Needed because being visible is not enough. Measured 2026-09-23: a listicle
 * hosted on kraya-ai.com names AiSensy, and the result host passed the
 * visibility check, so AiSensy was filed under Kraya's domain.
 */
export function domainMatchesName(domain: string, name: string): boolean {
  const label = (domain.split('.')[0] ?? '').replace(/[^a-z0-9]/g, '');
  const key = companyKey(name);
  if (label.length < 3 || key.length < 3) return false;
  return label.includes(key) || key.includes(label);
}

export function extractSystem(icp: Icp): string {
  return `You pull company names out of web search results and forum posts to build a prospect list.

The target customer (ICP): ${icp.description.trim()}

For each item, list the companies it names that SELL a product or service related to the ICP. Include competitors, vendors and providers mentioned in passing. For each:
- name: the brand exactly as written in the item (copy the spelling; do not expand or correct it).
- domain: the company's website domain only if it is written in the item or the item's URL is the company's own site. Otherwise null.
- context: up to 25 words copied verbatim from the item about this company.

Exclude: Meta, Facebook, WhatsApp itself, Google, Zapier, Make, n8n, Reddit, AI model vendors, and generic tools that are not in this market. Exclude people and job titles. If an item names no such company, return an empty list for it.

Return one entry per item id, in the order given.`;
}

const ITEM_LIMIT = 6000;

export function extractUser(items: EvidenceItem[]): string {
  return items.map((it, i) =>
    `<item id="${i}" url="${it.url}">\n${it.text.slice(0, ITEM_LIMIT)}\n</item>`,
  ).join('\n\n');
}

export const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'companies'],
        properties: {
          id: { type: 'string' },
          companies: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'domain', 'context'],
              properties: {
                name: { type: 'string' },
                domain: { type: ['string', 'null'] },
                context: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface ExtractResult {
  id: string;
  companies: Array<{ name: string; domain: string | null; context: string }>;
}

export interface ExtractedCompany {
  key: string;
  name: string;
  domain: string | null;
  snippet: string;
  item: EvidenceItem;
}

/**
 * Model output → companies we can stand behind. Drops unknown item ids, names
 * not present in the item's text, platform names, and domains we cannot see.
 * A snippet that is not verbatim is replaced by the item's own opening words.
 */
export function groundExtraction(items: EvidenceItem[], results: ExtractResult[]): ExtractedCompany[] {
  const out: ExtractedCompany[] = [];
  for (const r of results) {
    const item = items[Number(r.id)];
    if (!item) continue;
    const hay = normalise(`${item.text.slice(0, ITEM_LIMIT)} ${item.url}`);
    const host = hostOf(item.url);
    const seen = new Set<string>();

    for (const c of r.companies) {
      const name = c.name.trim();
      const key = companyKey(name);
      if (key.length < 2 || NEVER_PROSPECTS.has(key) || seen.has(key)) continue;
      if (!hay.includes(normalise(name))) continue;
      seen.add(key);

      const d = c.domain?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;
      const domain = d && (hay.includes(d) || host === d) && domainMatchesName(d, name) ? d : null;

      const ctx = c.context.trim();
      const snippet = ctx.length >= 10 && hay.includes(normalise(ctx)) ? ctx : windowAround(item.text, name);
      out.push({ key, name, domain, snippet, item });
    }
  }
  return out;
}

/** ~200 characters of the text around the first mention of `name`, verbatim. */
export function windowAround(text: string, name: string, radius = 100): string {
  const i = text.toLowerCase().indexOf(name.toLowerCase());
  const start = i === -1 ? 0 : Math.max(0, i - radius);
  const end = i === -1 ? 2 * radius : i + name.length + radius;
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/** Splits items into batches that stay under a character budget per call. */
export function batchByChars(items: EvidenceItem[], maxChars = 60_000, maxItems = 30): EvidenceItem[][] {
  const batches: EvidenceItem[][] = [];
  let cur: EvidenceItem[] = [];
  let size = 0;
  for (const it of items) {
    const len = Math.min(it.text.length, ITEM_LIMIT);
    if (cur.length && (size + len > maxChars || cur.length >= maxItems)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
