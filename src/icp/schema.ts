/**
 * An ICP file, validated.
 *
 * Strict on purpose: a misspelt key in YAML is otherwise silently ignored, and
 * a source that was meant to run and quietly didn't looks exactly like a source
 * that found nothing.
 */
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens');

export const RedditSourceSchema = z.strictObject({
  /** Subreddit names without the `r/` prefix. */
  communities: z.array(z.string().regex(/^[A-Za-z0-9_]+$/, 'subreddit name without r/')).default([]),
  /** Also run the searches across all of Reddit, not only inside the communities. */
  siteWide: z.boolean().default(true),
  searches: z.array(z.string().min(2)).min(1),
  time: z.enum(['all', 'hour', 'day', 'week', 'month', 'year']).default('year'),
  maxItemsPerRun: z.number().int().min(1).max(1000).default(50),
  /**
   * Off by default. With comments on, the item cap fills with a few threads'
   * replies instead of many posts: measured 3 posts + 57 comments vs 60 posts.
   */
  includeComments: z.boolean().default(false),
  /** Runs in flight at once. Each Reddit run takes ~8 minutes. */
  concurrency: z.number().int().min(1).max(8).default(3),
});

export const GoogleQuerySchema = z.strictObject({
  query: z.string().min(3).max(250),
  /**
   * A signal every company found by this query earns, e.g. `zapier-app` for
   * `site:zapier.com/apps whatsapp`. Omit for plain market searches.
   */
  signal: slug.optional(),
  /** Result pages to read, ~10 results each. */
  pages: z.number().int().min(1).max(5).default(1),
  /**
   * Also scrape each result page's text. Costs ~$0.008 a page, but a
   * "top 10 providers" article names ten companies and its snippet names one.
   */
  fetchContent: z.boolean().default(false),
});

export const GoogleSourceSchema = z.strictObject({
  /** Two-letter Google country, e.g. `in` for google.co.in. */
  countryCode: z.string().regex(/^[a-z]{2}$/).default('us'),
  queries: z.array(GoogleQuerySchema).min(1),
});

/** A per-company check: is this company listed under `site`? */
export const SignalCheckSchema = z.strictObject({
  signal: slug,
  /** Host and path prefix, e.g. `zapier.com/apps`. */
  site: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}(\/[a-z0-9._-]+)*$/, 'host and optional path, no scheme'),
});

export const SegmentSchema = z.strictObject({
  id: slug,
  description: z.string().min(5),
  /** Points added to the prospect score for this segment. */
  weight: z.number().min(0).max(50).default(0),
});

export const IcpSchema = z.strictObject({
  name: slug,
  description: z.string().min(10),
  geography: z.array(z.string()).default([]),
  buyerTitles: z.array(z.string()).default([]),
  /** How qualified companies are grouped. The model picks one per company, or none. */
  segments: z.array(SegmentSchema).default([]),
  hypotheses: z.array(z.strictObject({ id: slug, statement: z.string().min(10) })).default([]),
  /** Checked per qualified company by `npm run signals`. */
  signalChecks: z.array(SignalCheckSchema).default([]),
  sources: z.strictObject({
    reddit: RedditSourceSchema.optional(),
    google: GoogleSourceSchema.optional(),
  }),
});

export type Icp = z.infer<typeof IcpSchema>;
export type RedditSource = z.infer<typeof RedditSourceSchema>;
export type GoogleSource = z.infer<typeof GoogleSourceSchema>;
export type GoogleQuery = z.infer<typeof GoogleQuerySchema>;
export type SignalCheck = z.infer<typeof SignalCheckSchema>;
