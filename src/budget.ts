/**
 * A per-command spending cap.
 *
 * Checked BEFORE each paid call against that call's worst case, so the cap is
 * never crossed by the call that discovers it was crossed. Pure, so the rule is
 * tested without a network.
 */
export class Budget {
  readonly limitUsd: number;
  private spent = 0;

  constructor(limitUsd: number) {
    if (!(limitUsd >= 0)) throw new Error(`budget must be a non-negative number, got ${limitUsd}`);
    this.limitUsd = limitUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spent);
  }

  /** Whether a call costing at most `worstCaseUsd` fits in what is left. */
  allows(worstCaseUsd: number): boolean {
    return this.spent + worstCaseUsd <= this.limitUsd + 1e-9;
  }

  record(usd: number): void {
    this.spent += usd;
  }
}

/** `--budget 5` → 5. Missing means the caller's default; anything else unparseable is an error. */
export function parseBudgetFlag(args: string[], fallback: number): number {
  const i = args.indexOf('--budget');
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--budget needs a number of US dollars, got "${args[i + 1]}"`);
  return n;
}
