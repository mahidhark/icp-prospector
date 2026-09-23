/**
 * LinkedIn through HarvestAPI's Apify actors: companies, people, posts.
 *
 * Three batched runs, not one run per company: the company and posts actors
 * echo which input each result belongs to (`originalQuery.search`,
 * `query.targetUrl`), and the employees actor has a `one_by_one` mode with a
 * per-company cap. Profile search is the per-company fallback for companies
 * where the employees source found nobody — the two-source rule from
 * job-applier-agent, where each source has been the only one answering on
 * different days.
 *
 * Prices: Apify Store, 2026-09-23, FREE/BRONZE tier (the highest).
 */
import { companyKey } from '../resolve/extract.js';

export const LINKEDIN = {
  company: { actor: 'harvestapi/linkedin-company', startUsd: 0.00005, perItemUsd: 0.004 },
  employees: {
    actor: 'harvestapi/linkedin-company-employees',
    /** Charged per company in one_by_one mode. */
    perCompanyStartUsd: 0.02,
    perProfileUsd: { full: 0.008, fullEmail: 0.012 },
  },
  profileSearch: {
    actor: 'harvestapi/linkedin-profile-search',
    perSearchPageUsd: 0.1,
    perProfileUsd: { full: 0.004, fullEmail: 0.01 },
  },
  posts: { actor: 'harvestapi/linkedin-profile-posts', startUsd: 0.00005, perPostUsd: 0.002, perEmptyUsd: 0.001 },
} as const;

// ---------- companies ----------

export function companyRunInput(names: string[]): Record<string, unknown> {
  return { searches: names };
}

export const companyRunWorstUsd = (n: number) => (n ? LINKEDIN.company.startUsd + n * LINKEDIN.company.perItemUsd : 0);

export interface LinkedinCompanyItem {
  originalQuery?: { search?: string };
  name?: string;
  linkedinUrl?: string;
  website?: string | null;
  employeeCount?: number;
  tagline?: string;
  locations?: Array<{ headquarter?: boolean; parsed?: { text?: string; countryCode?: string } }>;
}

export interface LinkedinCompany {
  query: string;
  name: string;
  linkedinUrl: string;
  website: string | null;
  employees: number | null;
  hq: string | null;
  hqCountry: string | null;
}

export function normaliseCompany(item: LinkedinCompanyItem): LinkedinCompany | null {
  if (!item.linkedinUrl || !item.name) return null;
  const hq = item.locations?.find((l) => l.headquarter) ?? item.locations?.[0];
  return {
    query: item.originalQuery?.search?.trim() ?? '',
    name: item.name.trim(),
    linkedinUrl: item.linkedinUrl.replace(/\/$/, ''),
    website: item.website?.trim() || null,
    employees: item.employeeCount ?? null,
    hq: hq?.parsed?.text ?? null,
    hqCountry: hq?.parsed?.countryCode?.toUpperCase() ?? null,
  };
}

// ---------- people ----------

export interface PeopleOptions {
  titles: string[];
  perCompany: number;
  emails: boolean;
}

export function employeesRunInput(companyUrls: string[], o: PeopleOptions): Record<string, unknown> {
  return {
    companies: companyUrls,
    companyBatchMode: 'one_by_one',
    maxItemsPerCompany: o.perCompany,
    maxItems: companyUrls.length * o.perCompany,
    ...(o.titles.length ? { jobTitles: o.titles } : {}),
    // This actor's enum values carry the price in them; profile search's do not.
    profileScraperMode: o.emails ? 'Full + email search ($12 per 1k)' : 'Full ($8 per 1k)',
  };
}

export function employeesRunWorstUsd(companies: number, o: PeopleOptions): number {
  const per = o.emails ? LINKEDIN.employees.perProfileUsd.fullEmail : LINKEDIN.employees.perProfileUsd.full;
  return companies * (LINKEDIN.employees.perCompanyStartUsd + o.perCompany * per);
}

export function profileSearchInput(companyUrl: string, o: PeopleOptions): Record<string, unknown> {
  return {
    currentCompanies: [companyUrl],
    ...(o.titles.length ? { currentJobTitles: o.titles } : {}),
    maxItems: o.perCompany,
    takePages: 1,
    profileScraperMode: o.emails ? 'Full + email search' : 'Full',
  };
}

export function profileSearchWorstUsd(o: PeopleOptions): number {
  const per = o.emails ? LINKEDIN.profileSearch.perProfileUsd.fullEmail : LINKEDIN.profileSearch.perProfileUsd.full;
  return LINKEDIN.profileSearch.perSearchPageUsd + o.perCompany * per;
}

/** Both people sources, every field optional: they disagree on names. */
export interface RawPerson {
  firstName?: string;
  lastName?: string;
  headline?: string;
  linkedinUrl?: string;
  publicIdentifier?: string;
  location?: { linkedinText?: string };
  hiring?: boolean;
  emails?: Array<string | { email?: string; status?: string; qualityScore?: number }>;
  /** profile-search */
  currentPosition?: Array<{ position?: string; companyName?: string; companyLinkedinUrl?: string }>;
  /** company-employees */
  currentPositions?: Array<{ title?: string; companyName?: string; companyLinkedinUrl?: string; current?: boolean }>;
}

export interface Person {
  name: string;
  headline: string;
  /** The current position at the target company, when one is listed. */
  position: string;
  companyName: string;
  companyLinkedinUrl: string;
  profileUrl: string;
  location: string;
  emails: string[];
  hiring: boolean;
}

/**
 * A LinkedIn member id standing in for a profile slug does not open.
 * From job-applier-agent's profile.ts, where one reached the queue.
 */
const OPAQUE_MEMBER_ID = /\/in\/AC[A-Za-z0-9_-]{20,}/;

export function isResolvableProfileUrl(url: string): boolean {
  const u = url.trim();
  return !!u && /linkedin\.com\/in\//i.test(u) && !OPAQUE_MEMBER_ID.test(u);
}

const sameCompanyUrl = (a: string, b: string) =>
  a.toLowerCase().replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '') ===
  b.toLowerCase().replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '');

/**
 * One person, with the position they hold at `company`. The sources return
 * everyone's whole current-position list; only the one at the target counts.
 */
export function normalisePerson(p: RawPerson, company: { linkedinUrl: string; name: string }): Person {
  const positions = [
    ...(p.currentPosition ?? []).map((x) => ({ title: x.position, companyName: x.companyName, url: x.companyLinkedinUrl })),
    ...(p.currentPositions ?? []).filter((x) => x.current !== false)
      .map((x) => ({ title: x.title, companyName: x.companyName, url: x.companyLinkedinUrl })),
  ];
  const here = positions.find((x) => x.url && sameCompanyUrl(x.url, company.linkedinUrl))
    ?? positions.find((x) => x.companyName && companyKey(x.companyName) === companyKey(company.name));

  const emails = (p.emails ?? [])
    .map((e) => (typeof e === 'string' ? e : e.email ?? ''))
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e));

  return {
    name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim(),
    headline: p.headline?.trim() ?? '',
    position: here?.title?.trim() ?? '',
    companyName: here?.companyName?.trim() ?? '',
    companyLinkedinUrl: here?.url ?? '',
    profileUrl: (p.linkedinUrl?.trim() || (p.publicIdentifier ? `https://www.linkedin.com/in/${p.publicIdentifier}` : '')),
    location: p.location?.linkedinText?.trim() ?? '',
    emails: [...new Set(emails)],
    hiring: p.hiring === true,
  };
}

/** True when the person's listed current position is at the company. */
export const worksAt = (p: Person) => !!p.position && (!!p.companyLinkedinUrl || !!p.companyName);

/** Which of the run's companies a person belongs to, by their positions. */
export function companyOf(p: RawPerson, companies: Array<{ linkedinUrl: string; name: string }>) {
  return companies.find((c) => worksAt(normalisePerson(p, c)));
}

// ---------- posts ----------

export interface PostsOptions { maxPosts: number }

export function postsRunInput(profileUrls: string[], o: PostsOptions): Record<string, unknown> {
  return { targetUrls: profileUrls, maxPosts: o.maxPosts, postedLimit: 'year', includeReposts: false };
}

export const postsRunWorstUsd = (people: number, o: PostsOptions) =>
  people ? LINKEDIN.posts.startUsd + people * Math.max(o.maxPosts * LINKEDIN.posts.perPostUsd, LINKEDIN.posts.perEmptyUsd) : 0;

export interface RawPost {
  content?: string | null;
  linkedinUrl?: string;
  postedAt?: { date?: string } | string;
  query?: { targetUrl?: string };
  author?: { linkedinUrl?: string };
}

export interface Post {
  profileUrl: string;
  postUrl: string;
  postedAt: string | null;
  text: string;
}

export const normaliseProfileUrl = (u: string) =>
  u.trim().toLowerCase().replace(/^https?:\/\/([a-z]+\.)?linkedin\.com/, 'https://www.linkedin.com').replace(/\/$/, '');

export function normalisePost(item: RawPost): Post | null {
  const text = item.content?.trim() ?? '';
  const target = item.query?.targetUrl ?? item.author?.linkedinUrl ?? '';
  if (!text || !item.linkedinUrl || !target) return null;
  const date = typeof item.postedAt === 'string' ? item.postedAt : item.postedAt?.date ?? null;
  return { profileUrl: normaliseProfileUrl(target), postUrl: item.linkedinUrl, postedAt: date, text };
}
