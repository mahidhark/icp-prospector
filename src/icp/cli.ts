/**
 * npm run icp -- --check <file-or-name>
 *
 * Validates an ICP file and prints what `discover` would run and its worst-case
 * cost. Spends nothing.
 */
import { loadIcp } from './load.js';
import { planRedditRuns } from '../sources/reddit.js';

function main(): void {
  const args = process.argv.slice(2);
  const i = args.indexOf('--check');
  const ref = i === -1 ? undefined : args[i + 1];
  if (!ref) throw new Error('usage: npm run icp -- --check <icps/file.yaml | name>');

  const icp = loadIcp(ref);
  console.log(`OK  ${icp.name}`);
  console.log(`    ${icp.hypotheses.length} hypotheses, ${icp.buyerTitles.length} buyer titles`);

  const reddit = icp.sources.reddit;
  if (reddit) {
    const runs = planRedditRuns(reddit);
    const worst = runs.reduce((s, r) => s + r.worstCaseUsd, 0);
    console.log(`    reddit: ${runs.length} runs x up to ${reddit.maxItemsPerRun} items, worst case $${worst.toFixed(2)}`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
