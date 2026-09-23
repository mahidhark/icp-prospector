# CLAUDE.md

## Commands

```bash
npm install
npm run icp -- --check <name>        # validate an ICP, no spend
npm run discover -- --icp <name> --dry-run
npm run discover -- --icp <name> --budget 3   # SPENDS (Apify)
npm run themes -- --icp <name>                # SPENDS (Anthropic tokens)
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

## Rules

- **Nothing here contacts a person.** There is no send path, no DM and no
  connection request. The output is a list.
- **Quotes must be verbatim.** `groundQuote` checks them against the stored
  post. A quote that fails is dropped, never shown.
- **Secrets are only named, never stored.** `.env` is gitignored.
  `.env.example` lists names only.
- Scraped data (`out/`, the DB) never gets committed.
