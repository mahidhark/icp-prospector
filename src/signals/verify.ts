/**
 * Signal verification: does THIS company have a Zapier app, a Make app, an n8n
 * node?
 *
 * Why per company: measured 2026-09-23, `site:zapier.com/apps whatsapp`
 * returns Zapier's own WhatsApp pages and global long-tail tools, so only 4 of
 * 150 prospects earned a marketplace signal that way. Asking about each
 * company by name answers the question actually being asked.
 *
 * A hit counts only when the result is on the marketplace's own path AND its
 * URL or title contains the company's name. A pair page like
 * zapier.com/apps/google-sheets/integrations/aisensy still counts: Zapier
 * cannot list a pairing for an app that doesn't exist.
 */
import type { SignalCheck } from '../icp/schema.js';
import { companyKey, hostOf } from '../resolve/extract.js';
import { GOOGLE } from '../apify/actors.js';
import type { SerpHit } from '../sources/google.js';

export interface PlannedCheck {
  key: string;
  name: string;
  signal: string;
  site: string;
  query: string;
}

/** One Google query per company per signal. Names with quotes are stripped of them. */
export function planChecks(companies: Array<{ key: string; name: string }>, checks: SignalCheck[]): PlannedCheck[] {
  return companies.flatMap((c) => checks.map((s) => ({
    key: c.key,
    name: c.name,
    signal: s.signal,
    site: s.site,
    query: `site:${s.site} "${c.name.replace(/"/g, '')}"`,
  })));
}

export const checksWorstCaseUsd = (n: number): number => (n ? GOOGLE.startUsd + n * GOOGLE.perSerpPageUsd : 0);

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Whether a search hit proves the company is listed on the marketplace. */
export function hitConfirms(check: PlannedCheck, hit: Pick<SerpHit, 'url' | 'title'>): boolean {
  const host = hostOf(hit.url);
  const [siteHost, ...sitePath] = check.site.toLowerCase().split('/');
  if (!host || !siteHost || (host !== siteHost && !host.endsWith(`.${siteHost}`))) return false;
  let path: string;
  try {
    path = new URL(hit.url).pathname.toLowerCase();
  } catch {
    return false;
  }
  if (!path.startsWith(`/${sitePath.join('/')}`)) return false;

  const key = companyKey(check.name);
  if (key.length < 3) return false;
  return slugOf(path).includes(key) || slugOf(hit.title).includes(key);
}

export interface CheckOutcome {
  check: PlannedCheck;
  /** The first confirming hit, or null when none of the results confirmed it. */
  hit: Pick<SerpHit, 'url' | 'title' | 'description'> | null;
}

/** Matches every planned check against the hits for its query. */
export function resolveChecks(planned: PlannedCheck[], hits: SerpHit[]): CheckOutcome[] {
  const byQuery = new Map<string, SerpHit[]>();
  for (const h of hits) byQuery.set(h.query, [...(byQuery.get(h.query) ?? []), h]);
  return planned.map((check) => ({
    check,
    hit: (byQuery.get(check.query) ?? []).find((h) => hitConfirms(check, h)) ?? null,
  }));
}
