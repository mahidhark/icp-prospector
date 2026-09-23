/** npm run status — what is stored and what it cost, per ICP. No spend. */
import { openDb } from './store/db.js';

const db = openDb();

const mentions = db.prepare(
  `SELECT icp, source, COUNT(*) AS n,
          SUM(CASE WHEN kind = 'post' THEN 1 ELSE 0 END) AS posts
     FROM mentions GROUP BY icp, source ORDER BY icp, source`,
).all() as Array<{ icp: string; source: string; n: number; posts: number }>;

const observed = db.prepare(
  `SELECT icp, COUNT(*) AS n, SUM(relevant) AS relevant FROM observations GROUP BY icp`,
).all() as Array<{ icp: string; n: number; relevant: number }>;

const spend = db.prepare(
  `SELECT icp, kind, COUNT(*) AS calls, ROUND(SUM(usd), 3) AS usd FROM spend GROUP BY icp, kind`,
).all() as Array<{ icp: string; kind: string; calls: number; usd: number }>;

const tokens = db.prepare(
  `SELECT icp, model, COUNT(*) AS calls, SUM(input_tokens) AS inp, SUM(output_tokens) AS outp
     FROM model_calls GROUP BY icp, model`,
).all() as Array<{ icp: string; model: string; calls: number; inp: number; outp: number }>;

console.log('mentions');
for (const r of mentions) console.log(`  ${r.icp}  ${r.source}: ${r.n} (${r.posts} posts, ${r.n - r.posts} comments)`);
console.log('observations');
for (const r of observed) console.log(`  ${r.icp}: ${r.n} read, ${r.relevant} relevant`);
console.log('apify spend');
for (const r of spend) console.log(`  ${r.icp}  ${r.kind}: $${r.usd} over ${r.calls} runs`);
console.log('model usage');
for (const r of tokens) console.log(`  ${r.icp}  ${r.model}: ${r.calls} calls, ${r.inp} in / ${r.outp} out tokens`);
if (!mentions.length) console.log('\n(nothing stored yet — run `npm run discover -- --icp <name>`)');

db.close();
