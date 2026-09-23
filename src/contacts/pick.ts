/**
 * The two picks in contact enrichment, as pure rules.
 *
 * Which LinkedIn company is ours, and which people there to approach. Both are
 * judgements job-applier-agent left to a model; here they are rules, because
 * the inputs are structured and a wrong pick should be explainable by reading
 * a function rather than a transcript.
 */
import { companyKey, hostOf } from '../resolve/extract.js';
import type { LinkedinCompany, Person } from './linkedin.js';
import { isResolvableProfileUrl, worksAt } from './linkedin.js';

export interface CompanyMatch {
  company: LinkedinCompany;
  /** How we know it is the right one. */
  matchedBy: 'domain' | 'name';
}

const domainOf = (website: string | null): string | null => {
  if (!website) return null;
  return hostOf(/^https?:\/\//.test(website) ? website : `https://${website}`);
};

/**
 * The LinkedIn company that is ours: its website matches our domain, or,
 * failing that, its name normalises to our key. Anything looser (a fuzzy
 * name, "the first result") would put the wrong company's founder on the
 * list, which is worse than no row.
 */
export function pickLinkedinCompany(
  ours: { key: string; name: string; domain: string | null },
  candidates: LinkedinCompany[],
): CompanyMatch | null {
  if (ours.domain) {
    const byDomain = candidates.find((c) => domainOf(c.website) === ours.domain);
    if (byDomain) return { company: byDomain, matchedBy: 'domain' };
  }
  const byName = candidates.find((c) => companyKey(c.name) === ours.key);
  return byName ? { company: byName, matchedBy: 'name' } : null;
}

/**
 * Where a title sits in the ICP's buyer list; lower is better, -1 = not a buyer.
 * Matches on word boundaries so "CTO" does not match "Director", and not in
 * the possessive: measured 2026-09-23, "Founder" matched "Founder's Office
 * Associate", a common junior title at Indian startups, and put one on the list.
 */
export function titleRank(title: string, buyerTitles: string[]): number {
  const t = title.toLowerCase();
  return buyerTitles.findIndex((b) => new RegExp(`(^|[^a-z])${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z'’]|$)`).test(t));
}

export interface PickedContact {
  person: Person;
  rank: number;
  why: string;
}

/**
 * Up to `max` people: current position at the company, a profile link that
 * opens, and a title from the buyer list, best-ranked title first. Ties go to
 * the person with an email, then to the one hiring.
 */
export function pickContacts(people: Person[], buyerTitles: string[], max = 2): PickedContact[] {
  const seen = new Set<string>();
  return people
    .filter((p) => worksAt(p) && isResolvableProfileUrl(p.profileUrl) && p.name)
    // The position at THIS company only: a headline like "ex-Founder of X"
    // says nothing about the role they hold here.
    .map((p) => ({ person: p, rank: titleRank(p.position, buyerTitles) }))
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank
      || Number(b.person.emails.length > 0) - Number(a.person.emails.length > 0)
      || Number(b.person.hiring) - Number(a.person.hiring))
    .filter((c) => !seen.has(c.person.profileUrl) && (seen.add(c.person.profileUrl), true))
    .slice(0, max)
    .map((c) => ({ ...c, why: `${buyerTitles[c.rank]} (buyer title #${c.rank + 1}): ${c.person.position}` }));
}
