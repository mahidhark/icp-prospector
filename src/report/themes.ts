/**
 * The validation report: what people are saying, grouped into themes, tested
 * against the ICP's hypotheses.
 *
 * Two model passes, both cheap to re-run:
 *   observe      per mention: is it relevant, who is speaking, what pain, one
 *                verbatim quote, which hypotheses it bears on. Cached per
 *                mention, so a re-run only reads what is new.
 *   consolidate  one call over the relevant pains → named themes.
 *
 * Every quote in the report must appear verbatim in the post it cites. A quote
 * the model paraphrased is dropped rather than shown, because a report that
 * puts invented words in a stranger's mouth is worse than a shorter report.
 */
import type { Icp } from '../icp/schema.js';
import type { MentionRow, ObservationRow } from '../store/db.js';

export const SPEAKERS = ['smb_owner', 'builder_or_agency', 'tech_provider', 'developer', 'other'] as const;
export type Speaker = (typeof SPEAKERS)[number];

const BODY_LIMIT = 1500;

export const mentionKey = (source: string, id: string) => `${source}:${id}`;

export function mentionText(m: Pick<MentionRow, 'title' | 'body'>): string {
  return [m.title, m.body].filter(Boolean).join('\n');
}

// ---------- observe ----------

export function observeSystem(icp: Icp): string {
  const hyps = icp.hypotheses.map((h) => `- ${h.id}: ${h.statement.trim()}`).join('\n');
  return `You read public forum posts to test a go-to-market thesis. Be literal and sceptical.

The target customer (ICP): ${icp.description.trim()}

Hypotheses under test:
${hyps || '- (none)'}

For each post you are given, decide:
- relevant: true only if it says something about how businesses access, pay for, automate or integrate WhatsApp business messaging, or about the providers that sell that access. Generic WhatsApp consumer chatter is not relevant.
- speaker: who appears to be writing — smb_owner, builder_or_agency (freelancer, automation consultant, agency), tech_provider (works at or sells a WhatsApp BSP / tech provider product), developer, or other.
- pain: one short sentence, in your words, naming the problem or desire expressed. Null if none.
- quote: an exact, verbatim span copied from the post (10–200 characters) that best shows the pain. Copy characters exactly; do not fix spelling or join sentences. Null if nothing fits.
- hypotheses: for each hypothesis the post clearly bears on, its id and whether the post supports or undercuts it. Empty when it bears on none. Do not stretch.

Return one result per post id, in the order given.`;
}

export function observeUser(batch: MentionRow[]): string {
  return batch.map((m) => {
    const text = mentionText(m).slice(0, BODY_LIMIT);
    const where = m.community ? `r/${m.community}` : m.source;
    return `<post id="${mentionKey(m.source, m.external_id)}" kind="${m.kind}" where="${where}">\n${text}\n</post>`;
  }).join('\n\n');
}

export const OBSERVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'relevant', 'speaker', 'pain', 'quote', 'hypotheses'],
        properties: {
          id: { type: 'string' },
          relevant: { type: 'boolean' },
          speaker: { type: 'string', enum: [...SPEAKERS] },
          pain: { type: ['string', 'null'] },
          quote: { type: ['string', 'null'] },
          hypotheses: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'stance'],
              properties: {
                id: { type: 'string' },
                stance: { type: 'string', enum: ['supports', 'undercuts'] },
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface ObserveResult {
  id: string;
  relevant: boolean;
  speaker: Speaker;
  pain: string | null;
  quote: string | null;
  hypotheses: Array<{ id: string; stance: 'supports' | 'undercuts' }>;
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The quote if it appears verbatim (whitespace- and case-insensitive) in the text, else null. */
export function groundQuote(quote: string | null, text: string): string | null {
  if (!quote) return null;
  const q = quote.trim();
  if (q.length < 10) return null;
  return normalise(text).includes(normalise(q)) ? q : null;
}

/**
 * Model results → rows to store. Results for ids not in the batch are dropped,
 * unknown hypothesis ids are dropped, and ungrounded quotes are nulled.
 */
export function toObservations(batch: MentionRow[], results: ObserveResult[], icp: Icp): ObservationRow[] {
  const byKey = new Map(batch.map((m) => [mentionKey(m.source, m.external_id), m]));
  const hypIds = new Set(icp.hypotheses.map((h) => h.id));
  const out: ObservationRow[] = [];
  for (const r of results) {
    const m = byKey.get(r.id);
    if (!m) continue;
    byKey.delete(r.id);
    const hyps = r.relevant ? r.hypotheses.filter((h) => hypIds.has(h.id)) : [];
    out.push({
      source: m.source,
      external_id: m.external_id,
      relevant: r.relevant ? 1 : 0,
      speaker: r.speaker,
      pain: r.relevant ? r.pain : null,
      quote: r.relevant ? groundQuote(r.quote, mentionText(m)) : null,
      hypotheses: hyps.length ? JSON.stringify(hyps) : null,
    });
  }
  return out;
}

// ---------- consolidate ----------

export const CONSOLIDATE_SYSTEM = `You group short problem statements from forum posts into themes.

Make 4 to 10 themes. Each theme gets a short name (under 8 words), a one-sentence summary, and the ids of every statement that belongs to it. A statement belongs to at most one theme. Leave out statements that fit no theme rather than forcing them. Use only ids you were given.`;

export const CONSOLIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['themes'],
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'summary', 'ids'],
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export interface Theme {
  name: string;
  summary: string;
  ids: string[];
}

export function consolidateUser(obs: ObservationRow[]): string {
  return obs
    .filter((o) => o.relevant && o.pain)
    .map((o) => `${mentionKey(o.source, o.external_id)}\t${o.pain}`)
    .join('\n');
}

/** Drops ids the model invented and ids claimed by an earlier theme. */
export function cleanThemes(themes: Theme[], known: Set<string>): Theme[] {
  const used = new Set<string>();
  return themes
    .map((t) => ({
      ...t,
      ids: t.ids.filter((id) => known.has(id) && !used.has(id) && (used.add(id), true)),
    }))
    .filter((t) => t.ids.length > 0)
    .sort((a, b) => b.ids.length - a.ids.length);
}

// ---------- render ----------

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderThemes(
  icp: Icp, mentions: MentionRow[], obs: ObservationRow[], themes: Theme[], model: string, now = new Date(),
): string {
  const mByKey = new Map(mentions.map((m) => [mentionKey(m.source, m.external_id), m]));
  const oByKey = new Map(obs.map((o) => [mentionKey(o.source, o.external_id), o]));
  const relevant = obs.filter((o) => o.relevant);
  const communities = [...new Set(mentions.map((m) => (m.community ? `r/${m.community}` : m.source)))].sort();

  const link = (key: string) => {
    const m = mByKey.get(key);
    if (!m) return key;
    return `[${m.community ? `r/${m.community}` : m.source}](${m.url})`;
  };

  const lines: string[] = [];
  lines.push(`# Themes — ${icp.name}`, '');
  lines.push(`${now.toISOString().slice(0, 10)} · ${mentions.length} posts and comments read · ${relevant.length} relevant · model ${model}`, '');

  // Hypotheses
  if (icp.hypotheses.length) {
    lines.push('## Hypotheses', '');
    lines.push('| Hypothesis | Supports | Undercuts | Examples |', '| --- | ---: | ---: | --- |');
    for (const h of icp.hypotheses) {
      const sup: string[] = [];
      const und: string[] = [];
      for (const o of relevant) {
        const hs = o.hypotheses ? (JSON.parse(o.hypotheses) as ObserveResult['hypotheses']) : [];
        for (const x of hs) {
          if (x.id !== h.id) continue;
          (x.stance === 'supports' ? sup : und).push(mentionKey(o.source, o.external_id));
        }
      }
      const examples = [...sup.slice(0, 3), ...und.slice(0, 1)].map(link).join(', ');
      lines.push(`| **${h.id}** — ${esc(h.statement.trim())} | ${sup.length} | ${und.length} | ${examples || '—'} |`);
    }
    lines.push('');
  }

  // Themes
  lines.push('## Themes', '');
  lines.push('| Theme | Mentions | Who says it | Summary |', '| --- | ---: | --- | --- |');
  for (const t of themes) {
    const who = new Map<string, number>();
    for (const id of t.ids) {
      const s = oByKey.get(id)?.speaker ?? 'other';
      who.set(s, (who.get(s) ?? 0) + 1);
    }
    const whoText = [...who.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ');
    lines.push(`| ${esc(t.name)} | ${t.ids.length} | ${whoText} | ${esc(t.summary)} |`);
  }
  lines.push('');

  for (const t of themes) {
    const quoted = t.ids.filter((id) => oByKey.get(id)?.quote).slice(0, 3);
    if (!quoted.length) continue;
    lines.push(`### ${t.name}`, '');
    for (const id of quoted) lines.push(`> "${oByKey.get(id)!.quote}" — ${link(id)}`, '');
  }

  // Speakers
  const speakers = new Map<string, number>();
  for (const o of relevant) speakers.set(o.speaker ?? 'other', (speakers.get(o.speaker ?? 'other') ?? 0) + 1);
  lines.push('## Who is talking', '');
  lines.push([...speakers.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}: ${n}`).join(' · ') || '—', '');

  lines.push('## Sources', '');
  lines.push(`Collected from ${communities.join(', ')}. Quotes are verbatim and checked against the stored post; the model's paraphrases are never quoted.`, '');
  return lines.join('\n');
}
