import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { IcpSchema, type Icp } from './schema.js';
import { ICP_DIR } from '../config.js';

/** Accepts a path to a YAML file, or a bare ICP name looked up in `icps/`. */
export function resolveIcpPath(ref: string): string {
  if (ref.endsWith('.yaml') || ref.endsWith('.yml')) return ref;
  return join(ICP_DIR, `${ref}.yaml`);
}

export function parseIcp(yamlText: string): Icp {
  const result = IcpSchema.safeParse(parse(yamlText));
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid ICP:\n${lines.join('\n')}`);
  }
  return result.data;
}

export function loadIcp(ref: string): Icp {
  const path = resolveIcpPath(ref);
  if (!existsSync(path)) throw new Error(`no ICP file at ${path}`);
  return parseIcp(readFileSync(path, 'utf8'));
}
