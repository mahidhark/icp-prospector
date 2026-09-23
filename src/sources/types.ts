/**
 * What every source produces. Adapters normalise to this, so nothing
 * downstream learns which site a mention came from.
 *
 * A Mention is something a person wrote (a post, a comment). Company-list
 * sources arrive in a later session with their own shape.
 */
export interface Mention {
  source: string;
  /** Stable id within the source; the dedupe key. */
  externalId: string;
  kind: 'post' | 'comment';
  url: string;
  community: string | null;
  author: string | null;
  title: string | null;
  body: string;
  createdAt: string | null;
  /** The search that surfaced it, for the report's audit trail. */
  query: string | null;
}
