/**
 * npm run discover -- --icp <name> [--source reddit] [--budget 5] [--dry-run]
 *
 * Runs every configured source for an ICP and stores what it finds. Each paid
 * run reserves its worst case against the budget before it starts; a run that
 * could cross the cap is skipped and reported, not attempted. Runs go in
 * parallel because each takes minutes on Apify's side.
 */
import { loadIcp } from './icp/load.js';
import { Budget, parseBudgetFlag } from './budget.js';
import { openDb, recordSpend, upsertMention, type Db } from './store/db.js';
import { planRedditRuns, normaliseRedditItem, type RedditItem, type RedditRun } from './sources/reddit.js';
import { runActor } from './apify/client.js';
import { REDDIT, GOOGLE, actualRunCost } from './apify/actors.js';
import { planGoogleRuns, normaliseGoogleItem, type GoogleItem, type GoogleRun } from './sources/google.js';
import { upsertSerpHit } from './store/db.js';

const DEFAULT_BUDGET_USD = 5;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}

async function redditRun(db: Db, icpName: string, budget: Budget, run: RedditRun): Promise<void> {
  const label = run.community ? `r/${run.community}` : 'site-wide';
  const settle = budget.reserve(run.worstCaseUsd);
  if (!settle) {
    console.log(`  SKIPPED ${label}: worst case $${run.worstCaseUsd.toFixed(2)} exceeds remaining $${budget.remainingUsd.toFixed(2)}`);
    return;
  }
  console.log(`  started ${label}`);

  let outcome;
  try {
    outcome = await runActor<RedditItem>(REDDIT.actor, run.input);
  } catch (err) {
    // The start fee is charged even when the run fails, so it still counts.
    settle(REDDIT.startUsd);
    recordSpend(db, icpName, 'discover', REDDIT.actor, REDDIT.startUsd, `${label} FAILED`);
    console.log(`  FAILED ${label}: ${(err as Error).message}`);
    return;
  }

  // Apify's own figure when it gives one; the price table's otherwise.
  const cost = outcome.usageUsd ?? actualRunCost(REDDIT, outcome.items.length);
  settle(cost);
  recordSpend(db, icpName, 'discover', REDDIT.actor, cost, `${label} run=${outcome.runId} ${outcome.status}`);

  let fresh = 0;
  let skipped = 0;
  for (const item of outcome.items) {
    const m = normaliseRedditItem(item, label);
    if (!m) { skipped++; continue; }
    if (upsertMention(db, icpName, m)) fresh++;
  }
  console.log(`  ${label}: ${outcome.items.length} items, ${fresh} new, ${skipped} not text, $${cost.toFixed(3)} (${outcome.status})`);
}

async function googleRun(db: Db, icpName: string, budget: Budget, run: GoogleRun): Promise<void> {
  const label = `google x${run.queries.length} queries${run.queries[0]!.fetchContent ? ' +content' : ''}`;
  const settle = budget.reserve(run.worstCaseUsd);
  if (!settle) {
    console.log(`  SKIPPED ${label}: worst case $${run.worstCaseUsd.toFixed(2)} exceeds remaining $${budget.remainingUsd.toFixed(2)}`);
    return;
  }
  console.log(`  started ${label}`);

  let outcome;
  try {
    outcome = await runActor<GoogleItem>(GOOGLE.actor, run.input);
  } catch (err) {
    settle(GOOGLE.startUsd);
    recordSpend(db, icpName, 'discover', GOOGLE.actor, GOOGLE.startUsd, `${label} FAILED`);
    console.log(`  FAILED ${label}: ${(err as Error).message}`);
    return;
  }
  // No per-item price to fall back on for this actor, so the worst case stands in.
  const cost = outcome.usageUsd ?? run.worstCaseUsd;
  settle(cost);
  recordSpend(db, icpName, 'discover', GOOGLE.actor, cost, `${label} run=${outcome.runId} ${outcome.status}`);

  let hits = 0;
  let fresh = 0;
  let withContent = 0;
  for (const item of outcome.items) {
    for (const h of normaliseGoogleItem(item, run.queries)) {
      hits++;
      if (h.content) withContent++;
      if (upsertSerpHit(db, icpName, h)) fresh++;
    }
  }
  console.log(`  ${label}: ${outcome.items.length} pages, ${hits} results (${withContent} with page text), ${fresh} stored, $${cost.toFixed(3)} (${outcome.status})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const icpRef = flag(args, '--icp');
  if (!icpRef) throw new Error('usage: npm run discover -- --icp <name> [--source reddit] [--budget 5] [--dry-run]');
  const only = flag(args, '--source');
  const dryRun = args.includes('--dry-run');
  const budget = new Budget(parseBudgetFlag(args, DEFAULT_BUDGET_USD));

  const icp = loadIcp(icpRef);
  const db = openDb();

  const reddit = icp.sources.reddit;
  if (reddit && (!only || only === 'reddit')) {
    const runs = planRedditRuns(reddit);
    const worst = runs.reduce((s, r) => s + r.worstCaseUsd, 0);
    console.log(`reddit: ${runs.length} runs, ${reddit.concurrency} at a time, worst case $${worst.toFixed(2)}, budget $${budget.limitUsd.toFixed(2)}`);
    if (dryRun) {
      for (const r of runs) console.log(`  [dry-run] ${r.community ? `r/${r.community}` : 'site-wide'}: up to $${r.worstCaseUsd.toFixed(2)}`);
    } else {
      await pool(runs, reddit.concurrency, (run) => redditRun(db, icp.name, budget, run));
    }
  }

  const google = icp.sources.google;
  if (google && (!only || only === 'google')) {
    const runs = planGoogleRuns(google);
    const worst = runs.reduce((s, r) => s + r.worstCaseUsd, 0);
    console.log(`google: ${google.queries.length} queries in ${runs.length} runs, worst case $${worst.toFixed(2)}, budget left $${budget.remainingUsd.toFixed(2)}`);
    if (dryRun) {
      for (const r of runs) console.log(`  [dry-run] ${r.queries.length} queries${r.queries[0]!.fetchContent ? ' +content' : ''}: up to $${r.worstCaseUsd.toFixed(2)}`);
    } else {
      await Promise.all(runs.map((run) => googleRun(db, icp.name, budget, run)));
    }
  }

  console.log(`spent $${budget.spentUsd.toFixed(3)} of $${budget.limitUsd.toFixed(2)}`);
  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
