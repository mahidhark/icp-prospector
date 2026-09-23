/**
 * npm run discover -- --icp <name> [--source reddit] [--budget 5] [--dry-run]
 *
 * Runs every configured source for an ICP and stores what it finds. Each paid
 * call is checked against the budget before it starts; a call that could
 * cross it is skipped and reported, not attempted.
 */
import { loadIcp } from './icp/load.js';
import { Budget, parseBudgetFlag } from './budget.js';
import { openDb, recordSpend, upsertMention } from './store/db.js';
import { planRedditRuns, normaliseRedditItem, type RedditItem } from './sources/reddit.js';
import { runActorForItems } from './apify/client.js';
import { REDDIT, actualRunCost } from './apify/actors.js';

const DEFAULT_BUDGET_USD = 5;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
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

  if (icp.sources.reddit && (!only || only === 'reddit')) {
    const runs = planRedditRuns(icp.sources.reddit);
    const worst = runs.reduce((s, r) => s + r.worstCaseUsd, 0);
    console.log(`reddit: ${runs.length} runs, worst case $${worst.toFixed(2)}, budget $${budget.limitUsd.toFixed(2)}`);

    for (const run of runs) {
      const label = run.community ? `r/${run.community}` : 'site-wide';
      if (dryRun) {
        console.log(`  [dry-run] ${label}: up to $${run.worstCaseUsd.toFixed(2)}`);
        continue;
      }
      if (!budget.allows(run.worstCaseUsd)) {
        console.log(`  SKIPPED ${label}: worst case $${run.worstCaseUsd.toFixed(2)} exceeds remaining $${budget.remainingUsd.toFixed(2)}`);
        continue;
      }

      let items: RedditItem[];
      try {
        items = await runActorForItems<RedditItem>(REDDIT.actor, run.input, { timeoutSecs: 600 });
      } catch (err) {
        // The start fee is charged even when the run fails, so it still counts.
        budget.record(REDDIT.startUsd);
        recordSpend(db, icp.name, 'discover', REDDIT.actor, REDDIT.startUsd, `${label} FAILED`);
        console.log(`  FAILED ${label}: ${(err as Error).message}`);
        continue;
      }

      const cost = actualRunCost(REDDIT, items.length);
      budget.record(cost);
      recordSpend(db, icp.name, 'discover', REDDIT.actor, cost, label);

      let fresh = 0;
      let skipped = 0;
      for (const item of items) {
        const m = normaliseRedditItem(item, run.community ? `r/${run.community}` : 'site-wide');
        if (!m) { skipped++; continue; }
        if (upsertMention(db, icp.name, m)) fresh++;
      }
      console.log(`  ${label}: ${items.length} items, ${fresh} new, ${skipped} not text, $${cost.toFixed(3)}`);
    }
  }

  console.log(`spent $${budget.spentUsd.toFixed(3)} of $${budget.limitUsd.toFixed(2)}`);
  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
