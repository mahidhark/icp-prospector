/**
 * npm run capabilities -- --icp <name> [--fit icp] [--budget 1] [--dry-run]
 *
 * For each qualified company, runs the ICP's capability queries on Google and
 * judges, from snippets that name the company, whether it already has each
 * capability. Searches and judgements are stored once per pair. Re-run
 * `companies` afterwards to re-rank.
 */
import { loadIcp } from './icp/load.js';
import { Budget, parseBudgetFlag } from './budget.js';
import {
  openDb, companiesFor, qualificationsFor, capabilityQueriesDone, saveCapabilityHits, capabilitySnippets,
  capabilitiesFor, saveCapability, recordSpend, recordModelCall,
} from './store/db.js';
import {
  planCapabilityQueries, hitsAbout, judgeSystem, judgeUser, judgeSchema, groundJudgement,
  type CompanyCapabilityInput, type JudgeResult,
} from './capabilities/check.js';
import { checksWorstCaseUsd } from './signals/verify.js';
import { normaliseGoogleItem, type GoogleItem } from './sources/google.js';
import { runActor } from './apify/client.js';
import { GOOGLE } from './apify/actors.js';
import { anthropicModel } from './ai/anthropic.js';
import { MODEL } from './config.js';

const JUDGE_BATCH = 10;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const icpRef = flag(args, '--icp');
  if (!icpRef) throw new Error('usage: npm run capabilities -- --icp <name> [--fit icp] [--budget 1] [--dry-run]');
  const fits = new Set((flag(args, '--fit') ?? 'icp').split(','));
  const dryRun = args.includes('--dry-run');
  const budget = new Budget(parseBudgetFlag(args, 1));
  const icp = loadIcp(icpRef);
  if (!icp.capabilities.length) throw new Error(`${icp.name} defines no capabilities`);
  const db = openDb();

  const qualified = new Set(qualificationsFor(db, icp.name).filter((q) => fits.has(q.fit)).map((q) => q.key));
  const companies = companiesFor(db, icp.name).filter((c) => qualified.has(c.key));
  const done = capabilityQueriesDone(db, icp.name);
  const planned = planCapabilityQueries(companies, icp.capabilities).filter((p) => !done.has(`${p.key}|${p.query}`));

  // ---- search (Google snippets; the same per-page price as signal checks)
  let n = planned.length;
  while (n > 0 && !budget.allows(checksWorstCaseUsd(n))) n--;
  const batch = planned.slice(0, n);
  console.log(`search: ${planned.length} queries for ${companies.length} companies; ${batch.length} fit the budget (worst $${checksWorstCaseUsd(batch.length).toFixed(2)})`);
  if (dryRun) { db.close(); return; }

  if (batch.length) {
    const settle = budget.reserve(checksWorstCaseUsd(batch.length))!;
    const queries = batch.map((p) => ({ query: p.query, pages: 1, fetchContent: false }));
    const out = await runActor<GoogleItem>(GOOGLE.actor, {
      queries: queries.map((q) => q.query).join('\n'),
      maxPagesPerQuery: 1,
      countryCode: icp.sources.google?.countryCode ?? 'us',
      saveHtml: false,
      saveHtmlToKeyValueStore: false,
      maximumLeadsEnrichmentRecords: 0,
    }, { timeoutSecs: 3600 });
    const cost = Math.max(out.usageUsd ?? 0, GOOGLE.startUsd + out.items.length * GOOGLE.perSerpPageUsd);
    settle(cost);
    recordSpend(db, icp.name, 'capabilities', GOOGLE.actor, cost, `${batch.length} queries run=${out.runId} ${out.status}`);

    const answered = new Set(out.items.map((i) => i.searchQuery?.term?.trim() ?? ''));
    const hits = out.items.flatMap((i) => normaliseGoogleItem(i, queries.map((q) => ({ ...q, signal: undefined }))));
    let unanswered = 0;
    for (const p of batch) {
      if (!answered.has(p.query)) { unanswered++; continue; }
      saveCapabilityHits(db, icp.name, p.key, p.capability, p.query, hitsAbout(p.name, hits.filter((h) => h.query === p.query)));
    }
    console.log(`  ${out.items.length} result pages, ${unanswered} unanswered (retried next run), $${cost.toFixed(3)}`);
  }

  // ---- judge every company whose queries for a scale have all run, and that scale is unjudged
  const doneNow = capabilityQueriesDone(db, icp.name);
  const judged = new Set(capabilitiesFor(db, icp.name).map((r) => `${r.key}|${r.capability}`));
  const ready = (key: string, name: string, cap: (typeof icp.capabilities)[number]) =>
    planCapabilityQueries([{ key, name }], [cap]).every((p) => doneNow.has(`${key}|${p.query}`));
  const toJudge: CompanyCapabilityInput[] = companies
    .filter((c) => icp.capabilities.some((cap) => ready(c.key, c.name, cap) && !judged.has(`${c.key}|${cap.id}`)))
    .map((c) => ({ key: c.key, name: c.name, domain: c.domain, snippets: capabilitySnippets(db, icp.name, c.key).slice(0, 12) }));
  console.log(`judge: ${toJudge.length} companies`);
  const model = anthropicModel(MODEL);
  for (let i = 0; i < toJudge.length; i += JUDGE_BATCH) {
    const group = toJudge.slice(i, i + JUDGE_BATCH);
    const res = await model.parse<{ companies: JudgeResult[] }>(judgeSystem(icp), judgeUser(group), judgeSchema(icp) as Record<string, unknown>, 8000);
    recordModelCall(db, icp.name, 'capabilities', model.id, res.inputTokens, res.outputTokens);
    for (const r of groundJudgement(group, res.value.companies, icp)) saveCapability(db, icp.name, r, model.id);
    console.log(`  ${Math.min(i + JUDGE_BATCH, toJudge.length)}/${toJudge.length}`);
  }

  // ---- summary
  const all = capabilitiesFor(db, icp.name).filter((r) => qualified.has(r.key));
  for (const cap of icp.capabilities) {
    const rows = all.filter((r) => r.capability === cap.id);
    const counts = [...cap.levels.map((l) => l.id), 'unknown'].map((id) => `${id} ${rows.filter((r) => r.status === id).length}`);
    console.log(`  ${cap.id}: ${counts.join(', ')}`);
  }
  console.log(`spent $${budget.spentUsd.toFixed(3)}; re-rank with: npm run companies -- --icp ${icp.name}`);
  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
