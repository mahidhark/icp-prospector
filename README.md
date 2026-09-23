# icp-prospector

Give it an ICP (ideal customer profile). It finds prospect companies across several
sources, then enriches them with contacts and signals. **Sending stays human.**

```
icps/<name>.yaml  →  discover  →  themes (validate the problem)  →  companies  →  enrich  →  you reach out
                     paid,         model tokens                    later         later
                     budget-capped
```

Status: **validation stage works** (Reddit → themes report). Company sources
(Zapier / Make / n8n listings, Meta partner directory, Google) and LinkedIn
contact enrichment are the next two stages.

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
| `buyerTitles` | Who to reach at a prospect (used by enrichment, next stage) |
| `sources.reddit` | Communities, search terms, time window and `maxItemsPerRun` (the cost dial) |

Unknown keys are errors, so a typo cannot silently turn a source off.

## The themes report

- A table per hypothesis: how many posts support it, how many undercut it, with links.
- Themes: what people complain about, how often, and who is saying it (SMB owner, builder or agency, tech provider, developer).
- Up to three quotes per theme. **Every quote is verbatim.** The model's
  paraphrases are dropped, and the check runs against the stored post, not
  against the model's own output.

## Development

```bash
npm test
npm run typecheck
```

There is no build step: `tsx` runs TypeScript directly.

## License

MIT
