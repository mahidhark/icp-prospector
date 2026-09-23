/**
 * npm run themes -- --icp <name> [--max-new 400]
 *
 * Reads stored mentions, observes the ones not yet read (Anthropic tokens),
 * consolidates themes, writes out/<icp>/themes.md. No Apify spend.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadIcp } from '../icp/load.js';
import {
  openDb, mentionsFor, unobservedMentions, saveObservation, observationsFor, recordModelCall,
} from '../store/db.js';
import { anthropicModel } from '../ai/anthropic.js';
import { MODEL, OUT_DIR } from '../config.js';
import {
  observeSystem, observeUser, OBSERVE_SCHEMA, toObservations, type ObserveResult,
  CONSOLIDATE_SYSTEM, CONSOLIDATE_SCHEMA, consolidateUser, cleanThemes, renderThemes,
  mentionKey, type Theme,
} from './themes.js';

const BATCH = 25;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const icpRef = flag(args, '--icp');
  if (!icpRef) throw new Error('usage: npm run themes -- --icp <name> [--max-new 400]');
  const maxNew = Number(flag(args, '--max-new') ?? 400);

  const icp = loadIcp(icpRef);
  const db = openDb();
  const model = anthropicModel(MODEL);

  const todo = unobservedMentions(db, icp.name).slice(0, maxNew);
  console.log(`observing ${todo.length} new mentions in batches of ${BATCH}`);
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const res = await model.parse<{ results: ObserveResult[] }>(
      observeSystem(icp), observeUser(batch), OBSERVE_SCHEMA as unknown as Record<string, unknown>,
    );
    recordModelCall(db, icp.name, 'observe', model.id, res.inputTokens, res.outputTokens);
    const rows = toObservations(batch, res.value.results, icp);
    for (const r of rows) saveObservation(db, icp.name, r, model.id);
    console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}: ${rows.filter((r) => r.relevant).length} relevant, ${batch.length - rows.length} unanswered`);
  }

  const mentions = mentionsFor(db, icp.name);
  const obs = observationsFor(db, icp.name);
  const relevant = obs.filter((o) => o.relevant && o.pain);
  if (!relevant.length) throw new Error('no relevant observations yet — run discover first, or widen the searches');

  const res = await model.parse<{ themes: Theme[] }>(
    CONSOLIDATE_SYSTEM, consolidateUser(obs), CONSOLIDATE_SCHEMA as unknown as Record<string, unknown>,
  );
  recordModelCall(db, icp.name, 'consolidate', model.id, res.inputTokens, res.outputTokens);
  const themes = cleanThemes(res.value.themes, new Set(relevant.map((o) => mentionKey(o.source, o.external_id))));

  const dir = join(OUT_DIR, icp.name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'themes.md');
  writeFileSync(path, renderThemes(icp, mentions, obs, themes, model.id));
  console.log(`wrote ${path}: ${themes.length} themes over ${relevant.length} relevant mentions`);
  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
