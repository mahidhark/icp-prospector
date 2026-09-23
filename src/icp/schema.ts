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

export const IcpSchema = z.strictObject({
  name: slug,
  description: z.string().min(10),
  geography: z.array(z.string()).default([]),
  buyerTitles: z.array(z.string()).default([]),
  hypotheses: z.array(z.strictObject({ id: slug, statement: z.string().min(10) })).default([]),
  sources: z.strictObject({
    reddit: RedditSourceSchema.optional(),
  }),
});

export type Icp = z.infer<typeof IcpSchema>;
export type RedditSource = z.infer<typeof RedditSourceSchema>;
