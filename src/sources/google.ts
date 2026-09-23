/**
 * Google search, through `apify/google-search-scraper`.
 *
 * Why Google and not the directories themselves: checked 2026-09-23, Meta's
 * partner directory needs a Facebook login, Make's integrations page returns
 * 403 to scripts, and Zapier's public app API ignores its search parameter.
 * `site:zapier.com/apps whatsapp` reaches the same listings for $0.0045 a page.
 *
 * Queries sharing the same page count and content setting go in one run; the
 * actor takes queries as newline-separated text and reports which term each
 * results page belongs to.
 */
import type { GoogleQuery, GoogleSource } from '../icp/schema.js';
import { GOOGLE } from '../apify/actors.js';

export interface GoogleRun {
  queries: GoogleQuery[];
  input: Record<string, unknown>;
  worstCaseUsd: number;
}

/** A single organic result, flattened. */
export interface SerpHit {
  query: string;
  signal: string | null;
  url: string;
  title: string;
  description: string;
  position: number | null;
  /** The result page's own text, when the query asked for it. */
  content: string | null;
}

/** The fields of the actor's output we read. */
export interface GoogleItem {
  searchQuery?: { term?: string; page?: number };
  organicResults?: Array<{
    url?: string;
    title?: string;
    description?: string;
    position?: number;
    websiteContent?: { text?: string | null; markdown?: string | null } | null;
  }>;
}

/** A page's text is stored up to this length; listicles fit, whole sites do not. */
export const CONTENT_LIMIT = 20_000;

export function worstCaseForQueries(queries: GoogleQuery[]): number {
  return GOOGLE.startUsd + queries.reduce((sum, q) => {
    const serp = q.pages * GOOGLE.perSerpPageUsd;
    const content = q.fetchContent ? q.pages * GOOGLE.resultsPerSerpPage * GOOGLE.perContentPageUsd : 0;
    return sum + serp + content;
  }, 0);
}

/** The runs a Google source config expands to. Pure: no network, no spend. */
export function planGoogleRuns(cfg: GoogleSource): GoogleRun[] {
  const groups = new Map<string, GoogleQuery[]>();
  for (const q of cfg.queries) {
    const k = `${q.pages}|${q.fetchContent}`;
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  return [...groups.values()].map((queries) => {
    const { pages, fetchContent } = queries[0]!;
    return {
      queries,
      worstCaseUsd: worstCaseForQueries(queries),
      input: {
        queries: queries.map((q) => q.query).join('\n'),
        maxPagesPerQuery: pages,
        countryCode: cfg.countryCode,
        mobileResults: false,
        includeUnfilteredResults: false,
        saveHtml: false,
        saveHtmlToKeyValueStore: false,
        websiteContentScraper: { enable: fetchContent },
        maximumLeadsEnrichmentRecords: 0,
      },
    };
  });
}

/** One actor item (a results page) → its organic results, tagged with the query's signal. */
export function normaliseGoogleItem(item: GoogleItem, queries: GoogleQuery[]): SerpHit[] {
  const term = item.searchQuery?.term?.trim() ?? '';
  const q = queries.find((x) => x.query.trim() === term);
  const out: SerpHit[] = [];
  for (const r of item.organicResults ?? []) {
    if (!r.url || !r.title) continue;
    const text = r.websiteContent?.text ?? r.websiteContent?.markdown ?? null;
    out.push({
      query: q?.query ?? term,
      signal: q?.signal ?? null,
      url: r.url,
      title: r.title.trim(),
      description: (r.description ?? '').trim(),
      position: r.position ?? null,
      content: text ? text.slice(0, CONTENT_LIMIT) : null,
    });
  }
  return out;
}
