# CLAUDE.md

## Commands

```bash
npm install
npm run icp -- --check <name>        # validate an ICP, no spend
npm run discover -- --icp <name> --dry-run
npm run discover -- --icp <name> --budget 3   # SPENDS (Apify)
npm run themes -- --icp <name>                # SPENDS (Anthropic tokens)
npm run companies -- --icp <name>             # SPENDS (Anthropic tokens)
npm run signals -- --icp <name> --budget 2    # SPENDS (Apify), then re-run companies
npm run status
npm test
npm run typecheck
```

There is no `build` script. `npm run typecheck` is the gate that must pass
before a commit, along with `npm test`. Keep the test glob quoted (`'src/**/*.test.ts'`).
If it is unquoted, the shell expands it one level deep and nested tests stop running.

## Architecture

- `icps/*.yaml`: one file per ICP, validated by `src/icp/schema.ts` (strict).
- `src/sources/`: the only code that reads the outside world. Adapters
  normalise to `Mention` (`src/sources/types.ts`). Expanding a config into runs
  (`plan*Runs`) is kept pure, so cost is known before any call.
- `src/apify/actors.ts`: every actor with its price. Code names actors only
  from this table.
- `src/budget.ts`: the worst case is checked before each paid call, never after.
- `src/store/db.ts`: SQLite. Makes discovery and observation idempotent and
  records every Apify dollar and model token.
- `src/report/themes.ts`: pure prompt, schema, cleaning and rendering logic.
  `themes-cli.ts` is the only part that calls the model.
- `src/resolve/`: company extraction (`extract.ts`, which grounds names and
  domains) and qualification (`qualify.ts`, evidence-only). `src/score/score.ts`
  is the pure ranking. `companies-cli.ts` orchestrates them and calls
  `repairCompanies` every run, so a rule change also repairs stored rows.
- `src/signals/verify.ts`: per-company marketplace checks (pure). Confirmed
  listings are evidence with `source = 'verify'`. They are excluded from
  qualification staleness and from the page count.

## Rules

- **Nothing here contacts a person.** There is no send path, no DM and no
  connection request. The output is a list.
- **Company names must appear in their source, and domains must resemble the
  name.** `groundExtraction` enforces both. A company the model knows but the
  source never names must not reach the list.
- **Structured-output schemas must not put `null` inside an `enum`.** The API
  rejects it; use `anyOf: [{enum}, {type: 'null'}]`.
- **Quotes must be verbatim.** `groundQuote` checks them against the stored
  post. A quote that fails is dropped, never shown.
- **Secrets are only named, never stored.** `.env` is gitignored.
  `.env.example` lists names only.
- Scraped data (`out/`, the DB) never gets committed.
