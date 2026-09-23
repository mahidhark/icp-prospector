/**
 * Person signals from what they post, and one true thing to open with.
 *
 * The opener must rest on a verbatim quote from one of their posts, checked in
 * code, as with the themes report. An opener built on something the person
 * never said is the fastest way to lose the conversation it was meant to start.
 */
import type { Icp } from '../icp/schema.js';
import type { Post } from './linkedin.js';

const POST_LIMIT = 1200;

export function signalsSystem(icp: Icp): string {
  return `You read a person's recent LinkedIn posts to prepare a founder-to-founder discovery call. You never write the message itself.

We are selling to: ${icp.description.trim()}
The call explores these hypotheses:
${icp.hypotheses.map((h) => `- ${h.statement.trim()}`).join('\n') || '- (none given)'}

For each person, from their posts only:
- signals: which of these their posts clearly show. Empty if none.
${icp.personSignals.map((s) => `  - ${s.id}: ${s.description}`).join('\n')}
- opener: one sentence a caller could start with, about something specific they posted. Null if nothing specific.
- quote: 10 to 200 characters copied EXACTLY from the post the opener rests on. Null if opener is null.
- post: the index of that post. Null if opener is null.

Return one result per person id, in the order given.`;
}

export interface PersonPosts {
  id: string;
  name: string;
  title: string;
  company: string;
  posts: Post[];
}

export function signalsUser(people: PersonPosts[]): string {
  return people.map((p) => {
    const posts = p.posts.map((x, i) => `  <post index="${i}" date="${x.postedAt ?? ''}">\n${x.text.slice(0, POST_LIMIT)}\n  </post>`);
    return `<person id="${p.id}" name="${p.name}" title="${p.title}" company="${p.company}">\n${posts.join('\n')}\n</person>`;
  }).join('\n\n');
}

export const signalsSchema = (icp: Icp) => ({
  type: 'object',
  additionalProperties: false,
  required: ['people'],
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'signals', 'opener', 'quote', 'post'],
        properties: {
          id: { type: 'string' },
          signals: { type: 'array', items: { type: 'string', enum: icp.personSignals.map((x) => x.id) } },
          opener: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          post: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
    },
  },
});

export interface SignalsResult {
  id: string;
  signals: string[];
  opener: string | null;
  quote: string | null;
  post: number | null;
}

export interface GroundedSignals {
  id: string;
  signals: string[];
  opener: string | null;
  quote: string | null;
  postUrl: string | null;
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Keeps an opener only when its quote appears verbatim in the post it names.
 * Signals survive either way: they are tags, not claims put in anyone's mouth.
 */
export function groundSignals(people: PersonPosts[], results: SignalsResult[], icp: Icp): GroundedSignals[] {
  const allowed = new Set(icp.personSignals.map((x) => x.id));
  const byId = new Map(people.map((p) => [p.id, p]));
  const out: GroundedSignals[] = [];
  for (const r of results) {
    const person = byId.get(r.id);
    if (!person) continue;
    byId.delete(r.id);
    const post = r.post == null ? undefined : person.posts[r.post];
    const q = r.quote?.trim() ?? '';
    const grounded = !!(r.opener && post && q.length >= 10 && normalise(post.text.slice(0, POST_LIMIT)).includes(normalise(q)));
    out.push({
      id: r.id,
      signals: [...new Set(r.signals.filter((s) => allowed.has(s)))],
      opener: grounded ? r.opener!.trim() : null,
      quote: grounded ? q : null,
      postUrl: grounded ? post!.postUrl : null,
    });
  }
  return out;
}
