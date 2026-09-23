/**
 * npm run companies -- --icp <name> [--max-items 2000]
 *
 * Turns stored search results and relevant Reddit posts into a ranked
 * prospect list, out/<icp>/prospects.csv. Anthropic tokens only; no Apify.
 *
 *   extract   which companies does each item name? (cached per item)
 *   qualify   in the ICP? which segment? in the geography? (re-run only when
 *             a company has gained evidence since it was last judged)
 *   rank      pure scoring
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadIcp } from './icp/load.js';
import {
  openDb, capabilitiesFor, unextractedItems, markExtracted, upsertCompany, addEvidence, companiesFor,
  evidenceFor, qualificationsFor, saveQualification, recordModelCall, repairCompanies,
} from './store/db.js';
import { anthropicModel } from './ai/anthropic.js';
import { MODEL, OUT_DIR } from './config.js';
import {
  extractSystem, extractUser, EXTRACT_SCHEMA, groundExtraction, batchByChars, domainMatchesName, type ExtractResult,
} from './resolve/extract.js';
import {
  qualifySystem, qualifyUser, qualifySchema, toQualifications, groupEvidence, type QualifyResult,
} from './resolve/qualify.js';
import { rankProspects, toCsv } from './score/score.js';

const QUALIFY_BATCH = 20;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const icpRef = flag(args, '--icp');
  if (!icpRef) throw new Error('usage: npm run companies -- --icp <name> [--max-items 2000]');
  const maxItems = Number(flag(args, '--max-items') ?? 2000);

  const icp = loadIcp(icpRef);
  const db = openDb();
  const model = anthropicModel(MODEL);

  // ---- extract
  const items = unextractedItems(db, icp.name).slice(0, maxItems);
  const batches = batchByChars(items);
  console.log(`extract: ${items.length} new items in ${batches.length} calls`);
  let found = 0;
  for (const [i, batch] of batches.entries()) {
    const res = await model.parse<{ items: ExtractResult[] }>(
      extractSystem(icp), extractUser(batch), EXTRACT_SCHEMA as unknown as Record<string, unknown>, 16000,
    );
    recordModelCall(db, icp.name, 'extract', model.id, res.inputTokens, res.outputTokens);
    const companies = groundExtraction(batch, res.value.items);
    const tx = db.transaction(() => {
      for (const c of companies) {
        upsertCompany(db, icp.name, c.key, c.name, c.domain);
        addEvidence(db, icp.name, c.key, c.item, c.snippet);
      }
      for (const it of batch) markExtracted(db, icp.name, it, model.id);
    });
    tx();
    found += companies.length;
    console.log(`  ${i + 1}/${batches.length}: ${companies.length} company mentions kept`);
  }

  // ---- repair: domains that don't match their name, duplicates sharing a domain
  const repaired = repairCompanies(db, icp.name, domainMatchesName);
  if (repaired.cleared || repaired.merged) console.log(`repair: ${repaired.cleared} mismatched domains cleared, ${repaired.merged} duplicates merged`);

  // ---- qualify
  const companies = companiesFor(db, icp.name);
  const evidence = groupEvidence(evidenceFor(db, icp.name));
  const judged = new Map(qualificationsFor(db, icp.name).map((q) => [q.key, q]));
  // Signal checks confirm a listing, not what a company does, so they never
  // make a judgement stale.
  const judgedEvidence = (key: string) => (evidence.get(key) ?? []).filter((e) => e.source !== 'verify').length;
  const todo = companies.filter((c) => {
    const q = judged.get(c.key);
    return !q || q.evidence_n < judgedEvidence(c.key);
  });
  console.log(`qualify: ${todo.length} of ${companies.length} companies need a (re)judgement`);
  for (let i = 0; i < todo.length; i += QUALIFY_BATCH) {
    const batch = todo.slice(i, i + QUALIFY_BATCH);
    const res = await model.parse<{ results: QualifyResult[] }>(
      qualifySystem(icp), qualifyUser(batch, evidence), qualifySchema(icp) as Record<string, unknown>, 8000,
    );
    recordModelCall(db, icp.name, 'qualify', model.id, res.inputTokens, res.outputTokens);
    const rows = toQualifications(batch, res.value.results, evidence, icp);
    for (const r of rows) saveQualification(db, icp.name, r, model.id);
    console.log(`  ${Math.min(i + QUALIFY_BATCH, todo.length)}/${todo.length}: ${rows.filter((r) => r.fit === 'icp').length} icp, ${batch.length - rows.length} unanswered`);
  }

  // ---- rank
  const ranked = rankProspects(icp, companies, qualificationsFor(db, icp.name), evidence, capabilitiesFor(db, icp.name));
  const kept = ranked.filter((p) => p.fit !== 'not').map((p, i) => ({ ...p, rank: i + 1 }));
  const dir = join(OUT_DIR, icp.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prospects.csv'), toCsv(kept));
  const fits = { icp: 0, adjacent: 0, not: 0 } as Record<string, number>;
  for (const p of ranked) fits[p.fit] = (fits[p.fit] ?? 0) + 1;
  console.log(`wrote ${join(dir, 'prospects.csv')}: ${kept.length} prospects (${fits.icp} icp, ${fits.adjacent} adjacent; ${fits.not} not a fit left out); ${found} new mentions this run`);
  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
