/**
 * Minimal Apify REST client, copied from job-applier-agent.
 *
 * `run-sync-get-dataset-items`, NOT `run-sync`: the latter returns the actor's
 * OUTPUT record, which scrapers don't write, so the body comes back empty.
 * An empty body is raised, never read as "no results" — that is how a total
 * outage hides behind "0 new".
 */
import { APIFY_TOKEN } from '../config.js';

const BASE = 'https://api.apify.com/v2';

/** Actor names are `user/name`; the REST path wants `user~name`. */
const toPath = (actor: string) => actor.replace('/', '~');

export async function runActorForItems<T>(
  actor: string,
  input: Record<string, unknown>,
  { timeoutSecs = 300, memoryMbytes = 1024, limit = 1000 } = {},
): Promise<T[]> {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set — add it to .env');

  const url =
    `${BASE}/acts/${toPath(actor)}/run-sync-get-dataset-items` +
    `?timeout=${timeoutSecs}&memory=${memoryMbytes}&clean=true&limit=${limit}`;

  const res = await fetch(url, {
    method: 'POST',
    // Header rather than query string, so the token never lands in a logged URL.
    headers: { 'content-type': 'application/json', authorization: `Bearer ${APIFY_TOKEN}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`apify ${actor}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  const text = await res.text();
  if (!text.trim()) throw new Error(`apify ${actor}: empty response body`);
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`apify ${actor}: expected an array of items, got ${typeof parsed}`);
  }
  return parsed as T[];
}
