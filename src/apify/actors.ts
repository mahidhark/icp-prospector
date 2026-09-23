/**
 * Every actor this tool may run, with its price.
 *
 * Code names actors from this table only, so nothing — a config file, a model —
 * can choose an arbitrary actor and with it an arbitrary bill. Prices are the
 * Apify FREE tier (the highest), read from the Store on 2026-09-23; a paid plan
 * is cheaper, so estimates err high.
 */
export interface ActorPrice {
  actor: string;
  /** Flat fee per run, at the memory the run uses. */
  startUsd: number;
  /** Charged per dataset item stored. */
  perItemUsd: number;
}

export const REDDIT: ActorPrice = {
  actor: 'trudax/reddit-scraper-lite',
  startUsd: 0.02, // per 1 GB; runs use 1024 MB
  perItemUsd: 0.004,
};

/**
 * Google search. Charged per results PAGE, not per result, plus an optional
 * per-page charge for scraping each result's own page.
 */
export const GOOGLE = {
  actor: 'apify/google-search-scraper',
  startUsd: 0.001,
  perSerpPageUsd: 0.0045,
  perContentPageUsd: 0.008,
  resultsPerSerpPage: 10,
} as const;

/** Worst case for one run: every item slot filled. */
export const maxRunCost = (p: ActorPrice, maxItems: number): number =>
  p.startUsd + p.perItemUsd * maxItems;

/** What a finished run actually cost, from the items it returned. */
export const actualRunCost = (p: ActorPrice, items: number): number =>
  p.startUsd + p.perItemUsd * items;
