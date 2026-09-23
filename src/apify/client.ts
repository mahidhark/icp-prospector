/**
 * Minimal Apify REST client: start a run, wait for it, read its dataset.
 *
 * NOT `run-sync-get-dataset-items`, which job-applier-agent uses. That endpoint
 * gives up after 300 seconds no matter what `timeout` says (HTTP 408
 * run-timeout-exceeded), while the run carries on — and bills — on Apify's
 * side. A 60-post Reddit search took 490 s on 2026-09-23, so the sync endpoint
 * would have charged for data this process never saw.
 *
 * An empty or malformed dataset is raised, never read as "no results": that is
 * how a total outage hides behind "0 new".
 */
import { APIFY_TOKEN } from '../config.js';

const BASE = 'https://api.apify.com/v2';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

/** Actor names are `user/name`; the REST path wants `user~name`. */
const toPath = (actor: string) => actor.replace('/', '~');

export interface RunOutcome<T> {
  items: T[];
  runId: string;
  status: string;
  /** What Apify says the run cost. Null if it did not report one. */
  usageUsd: number | null;
}

interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId: string;
  usageTotalUsd?: number;
  statusMessage?: string;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set — add it to .env');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    // Header rather than query string, so the token never lands in a logged URL.
    headers: { 'content-type': 'application/json', authorization: `Bearer ${APIFY_TOKEN}`, ...init.headers },
  });
  if (!res.ok) throw new Error(`apify ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  if (!text.trim()) throw new Error(`apify ${path.split('?')[0]}: empty response body`);
  return JSON.parse(text) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runActor<T>(
  actor: string,
  input: Record<string, unknown>,
  { timeoutSecs = 1200, memoryMbytes = 1024, pollMs = 10_000 } = {},
): Promise<RunOutcome<T>> {
  let run = (await api<{ data: ApifyRun }>(
    `/acts/${toPath(actor)}/runs?timeout=${timeoutSecs}&memory=${memoryMbytes}`,
    { method: 'POST', body: JSON.stringify(input) },
  )).data;

  while (!TERMINAL.has(run.status)) {
    await sleep(pollMs);
    run = (await api<{ data: ApifyRun }>(`/actor-runs/${run.id}`)).data;
  }

  // A run that timed out or was aborted still stored what it had; keep it.
  const parsed = await api<unknown>(`/datasets/${run.defaultDatasetId}/items?clean=true`);
  if (!Array.isArray(parsed)) throw new Error(`apify ${actor}: expected an array of items, got ${typeof parsed}`);
  if (run.status === 'FAILED' && parsed.length === 0) {
    throw new Error(`apify ${actor}: run ${run.id} FAILED ${run.statusMessage ?? ''}`.trim());
  }
  return { items: parsed as T[], runId: run.id, status: run.status, usageUsd: run.usageTotalUsd ?? null };
}
