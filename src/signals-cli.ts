/**
 * npm run signals -- --icp <name> [--fit icp,adjacent] [--budget 2] [--dry-run]
 *
 * For each qualified company, asks Google whether it is listed on each
 * marketplace in the ICP's `signalChecks`, and records confirmed listings as
 * signal evidence. Each company-signal pair is checked once, ever. Re-run
 * `companies` afterwards to re-rank.
 */
import { loadIcp } from './icp/load.js';
import { Budget, parseBudgetFlag } from './budget.js';
import {
  openDb, companiesFor, qualificationsFor, checkedSignals, saveSignalCheck, addEvidence, recordSpend,
} from './store/db.js';
import { planChecks, checksWorstCaseUsd, resolveChecks } from './signals/verify.js';
import { normaliseGoogleItem, type GoogleItem, type SerpHit } from './sources/google.js';
import { runActor } from './apify/client.js';
import { GOOGLE } from './apify/actors.js';

const DEFAULT_BUDGET_USD = 2;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const icpRef = flag(args, '--icp');
  if (!icpRef) throw new Error('usage: npm run signals -- --icp <name> [--fit icp,adjacent] [--budget 2] [--dry-run]');
  const fits = new Set((flag(args, '--fit') ?? 'icp').split(','));
  const dryRun = args.includes('--dry-run');
  const budget = new Budget(parseBudgetFlag(args, DEFAULT_BUDGET_USD));

  const icp = loadIcp(icpRef);
  if (!icp.signalChecks.length) throw new Error(`${icp.name} defines no signalChecks`);
  const db = openDb();

  const qualified = new Set(qualificationsFor(db, icp.name).filter((q) => fits.has(q.fit)).map((q) => q.key));
  const done = checkedSignals(db, icp.name);
  const planned = planChecks(companiesFor(db, icp.name).filter((c) => qualified.has(c.key)), icp.signalChecks)
    .filter((p) => !done.has(`${p.key}|${p.signal}`));

  // Fit the batch to the budget rather than refusing it whole.
  let n = planned.length;
  while (n > 0 && !budget.allows(checksWorstCaseUsd(n))) n--;
  const batch = planned.slice(0, n);
  console.log(`signals: ${planned.length} checks to run for ${qualified.size} ${[...fits].join('/')} companies; ${batch.length} fit the $${budget.limitUsd.toFixed(2)} budget (worst case $${checksWorstCaseUsd(batch.length).toFixed(2)})`);
  if (dryRun || !batch.length) { db.close(); return; }

  const settle = budget.reserve(checksWorstCaseUsd(batch.length))!;
  const queries = batch.map((p) => ({ query: p.query, signal: p.signal, pages: 1, fetchContent: false }));
  let outcome;
  try {
    outcome = await runActor<GoogleItem>(GOOGLE.actor, {
      queries: queries.map((q) => q.query).join('\n'),
      maxPagesPerQuery: 1,
      countryCode: icp.sources.google?.countryCode ?? 'us',
      saveHtml: false,
      saveHtmlToKeyValueStore: false,
      maximumLeadsEnrichmentRecords: 0,
    }, { timeoutSecs: 3600 });
  } catch (err) {
    settle(GOOGLE.startUsd);
    recordSpend(db, icp.name, 'signals', GOOGLE.actor, GOOGLE.startUsd, 'FAILED');
    throw err;
  }
  const cost = outcome.usageUsd ?? checksWorstCaseUsd(batch.length);
  settle(cost);
  recordSpend(db, icp.name, 'signals', GOOGLE.actor, cost, `${batch.length} checks run=${outcome.runId} ${outcome.status}`);

  const hits: SerpHit[] = outcome.items.flatMap((item) => normaliseGoogleItem(item, queries));
  // Terms Google returned a results page for, even an empty one.
  const answered = new Set(outcome.items.map((i) => i.searchQuery?.term?.trim() ?? ''));
  const results = resolveChecks(batch, hits);

  let confirmed = 0;
  let unanswered = 0;
  const tx = db.transaction(() => {
    for (const r of results) {
      // A query Google returned no page for is not a "no"; leave it to retry.
      if (!answered.has(r.check.query)) {
        unanswered++;
        continue;
      }
      saveSignalCheck(db, icp.name, r.check.key, r.check.signal, !!r.hit, r.hit?.url ?? null, r.check.query);
      if (r.hit) {
        confirmed++;
        addEvidence(db, icp.name, r.check.key, {
          source: 'verify', ref: `${r.check.signal} ${r.hit.url}`, url: r.hit.url,
          text: r.hit.title, signal: r.check.signal,
        }, r.hit.title);
      }
    }
  });
  tx();

  const bySignal = new Map<string, number>();
  for (const r of results) if (r.hit) bySignal.set(r.check.signal, (bySignal.get(r.check.signal) ?? 0) + 1);
  console.log(`  ${confirmed} listings confirmed (${[...bySignal].map(([s, k]) => `${s} ${k}`).join(', ') || 'none'}), ${unanswered} unanswered (retried next run), $${cost.toFixed(3)}`);
  console.log('  re-rank with: npm run companies -- --icp ' + icp.name);
  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
