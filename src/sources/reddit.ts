/**
 * Reddit, through `trudax/reddit-scraper-lite`.
 *
 * One actor run per community plus one site-wide run, rather than search URLs
 * in `startUrls`: the actor's `searchCommunityName` field is documented, a
 * hand-built search URL is not. The extra runs cost $0.02 each.
 *
 * We collect what people wrote, never who to message: the output is posts and
 * comments to analyse, and company names come out of them later.
 */
import type { RedditSource } from '../icp/schema.js';
import type { Mention } from './types.js';
import { REDDIT, maxRunCost } from '../apify/actors.js';

/** The fields of the actor's output we read. Everything else is ignored. */
export interface RedditItem {
  id?: string;
  parsedId?: string;
  dataType?: string;
  url?: string;
  link?: string;
  communityName?: string;
  parsedCommunityName?: string;
  username?: string;
  title?: string;
  body?: string;
  createdAt?: string;
}

export interface RedditRun {
  /** null = site-wide. */
  community: string | null;
  input: Record<string, unknown>;
  worstCaseUsd: number;
}

/** The runs a Reddit source config expands to. Pure: no network, no spend. */
export function planRedditRuns(cfg: RedditSource): RedditRun[] {
  const scopes: Array<string | null> = [...cfg.communities, ...(cfg.siteWide ? [null] : [])];
  return scopes.map((community) => ({
    community,
    worstCaseUsd: maxRunCost(REDDIT, cfg.maxItemsPerRun),
    input: {
      searches: cfg.searches,
      ...(community ? { searchCommunityName: community } : {}),
      searchPosts: true,
      searchComments: false,
      searchCommunities: false,
      searchUsers: false,
      sort: 'relevance',
      time: cfg.time,
      includeNSFW: false,
      skipUserPosts: true,
      skipCommunity: true,
      // Comments under a matching post are where the complaints are; keep some.
      skipComments: false,
      maxComments: 10,
      maxItems: cfg.maxItemsPerRun,
      maxPostCount: cfg.maxItemsPerRun,
      proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    },
  }));
}

/**
 * One actor item → a Mention, or null when it is not text a person wrote
 * (community metadata, user pages, deleted bodies).
 */
export function normaliseRedditItem(item: RedditItem, query: string | null): Mention | null {
  const kind = item.dataType === 'post' ? 'post' : item.dataType === 'comment' ? 'comment' : null;
  if (!kind) return null;

  const id = item.id ?? item.parsedId;
  const url = item.url ?? item.link;
  const body = (item.body ?? '').trim();
  const title = item.title?.trim() || null;
  if (!id || !url) return null;
  if (!body && !title) return null;
  if (body === '[deleted]' || body === '[removed]') return null;

  return {
    source: 'reddit',
    externalId: id,
    kind,
    url,
    community: item.parsedCommunityName ?? item.communityName?.replace(/^r\//, '') ?? null,
    author: item.username ?? null,
    title,
    body,
    createdAt: item.createdAt ?? null,
    query,
  };
}
