# icp-prospector

Give it an ICP (ideal customer profile). It finds prospect companies across several
sources, then enriches them with contacts and signals. **Sending stays human.**

```
icps/<name>.yaml  →  discover  →  themes (validate the problem)  →  companies  →  enrich  →  you reach out
                     paid,         model tokens                    later         later
                     budget-capped
```

Status: **validation and company stages work.** Reddit and Google feed a
themes report and a ranked prospect list. LinkedIn contact enrichment is next.

## Why nothing sends

The tool stops at a list. Automated DMs and connection requests break the
terms of LinkedIn and Reddit and burn the account doing it. Who you pick and
what you say decide whether a conversation happens; the click does not.

## Setup

Node 22 or newer.

```bash
npm install
cp .env.example .env     # then fill in APIFY_TOKEN and ANTHROPIC_API_KEY
```

- `APIFY_TOKEN`: from https://console.apify.com/settings/integrations. Pays for scraping.
- `ANTHROPIC_API_KEY`: reads the scraped posts and writes the themes.

Data is stored in `~/.icp-prospector/prospector.db` (set `ICP_DB` to move it).
Reports are written to `out/<icp>/`. Both hold scraped third-party text and
are gitignored.

## Run it

```bash
npm run icp -- --check meta-tech-providers-india       # validate the ICP, show worst-case cost. Free.
npm run discover -- --icp meta-tech-providers-india --dry-run
npm run discover -- --icp meta-tech-providers-india --budget 3
npm run themes -- --icp meta-tech-providers-india      # → out/meta-tech-providers-india/themes.md
npm run companies -- --icp meta-tech-providers-india   # → out/meta-tech-providers-india/prospects.csv
npm run status                                          # what is stored, what it cost
```

Every paid command takes `--budget` in US dollars (default 5). Before each paid
call it checks that call's worst-case cost against what is left, and skips the
call if it would cross the cap. `discover` is idempotent: re-running only adds
posts it has not seen, and `themes` only reads posts it has not read yet.

## Define a new ICP

Copy `icps/meta-tech-providers-india.yaml` and edit it. The fields:

| Field | What it does |
| --- | --- |
| `name` | Slug; also the output folder name |
| `description` | Who the customer is. The model uses it to judge relevance |
| `hypotheses` | What you believe. The report counts posts that support or undercut each |
| `segments` | How prospects are grouped; `weight` adds to the score, so it sets call order |
| `buyerTitles` | Who to reach at a prospect (used by enrichment, next stage) |
| `sources.reddit` | Communities, search terms, time window and `maxItemsPerRun` (the cost dial) |
| `sources.google` | Queries, each with `pages`, an optional `signal` it awards, and `fetchContent` for listicles |

Unknown keys are errors, so a typo cannot silently turn a source off.

## The themes report

- A table per hypothesis: how many posts support it, how many undercut it, with links.
- Themes: what people complain about, how often, and who is saying it (SMB owner, builder or agency, tech provider, developer).
- Up to three quotes per theme. **Every quote is verbatim.** The model's
  paraphrases are dropped, and the check runs against the stored post, not
  against the model's own output.

## The prospect list

`companies` reads every stored search result and every relevant Reddit post, then:

1. **Extract.** Claude lists the companies each item names. A name is kept only
   if it appears in the item. A domain is kept only if it is visible and
   resembles the name, so a listicle hosted on one vendor's blog doesn't give
   its domain to the vendors it lists.
2. **Qualify.** Claude judges fit (icp, adjacent or not), segment and
   geography, **from the collected evidence only**. When the evidence doesn't
   say, the answer is `unknown`.
3. **Rank.** A plain formula adds points for fit, geography, segment weight,
   signals, Reddit mentions, number of pages and appearing in both sources.
   `score_breakdown` in the CSV shows every point.

Re-runs are incremental: items already read are skipped, and a company is only
re-judged when it has gained evidence.

## Development

```bash
npm test
npm run typecheck
```

There is no build step: `tsx` runs TypeScript directly.

## License

MIT
