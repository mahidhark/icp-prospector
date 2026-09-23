/** Paths and environment. Nothing scraped lives inside this repo. */
import { join } from 'node:path';
import { homedir } from 'node:os';

/** SQLite state. Outside the repo by default; `data/` is gitignored anyway. */
export const DB_PATH = process.env.ICP_DB ?? join(homedir(), '.icp-prospector', 'prospector.db');

export const ICP_DIR = process.env.ICP_DIR ?? 'icps';

/** Reports land here, one folder per ICP. Gitignored: they quote third-party posts. */
export const OUT_DIR = process.env.ICP_OUT_DIR ?? 'out';

/** Apify REST token. Required only by paid sources. */
export const APIFY_TOKEN = process.env.APIFY_TOKEN ?? '';

export const MODEL = process.env.ICP_MODEL ?? 'claude-sonnet-5';
