/** Raised when a model call would push an org over its token budget. Carried as
 *  a typed error so the orchestrator can degrade gracefully (decline the turn)
 *  rather than crash. */
export class BudgetExceededError extends Error {
  constructor(
    readonly orgId: string,
    readonly requested: number,
    readonly remaining: number,
  ) {
    super(`budget exceeded for org "${orgId}": needs ${requested} tokens, ${remaining} remaining`);
    this.name = "BudgetExceededError";
  }
}

/**
 * Per-org token budget ledger. `wouldExceed` is the pre-flight check (pure, no
 * mutation); `add` settles the actual spend after a call. Splitting them lets the
 * gateway reject BEFORE spending, and record real usage after, without a spurious
 * post-call throw.
 */
export class BudgetLedger {
  private readonly spentByOrg = new Map<string, number>();

  constructor(private readonly perOrgLimit: number) {}

  spent(orgId: string): number {
    return this.spentByOrg.get(orgId) ?? 0;
  }

  remaining(orgId: string): number {
    return Math.max(0, this.perOrgLimit - this.spent(orgId));
  }

  wouldExceed(orgId: string, tokens: number): boolean {
    return this.spent(orgId) + tokens > this.perOrgLimit;
  }

  /** Settle actual spend. Never throws — the pre-flight `wouldExceed` guards. */
  add(orgId: string, tokens: number): void {
    this.spentByOrg.set(orgId, this.spent(orgId) + tokens);
  }

  reset(orgId?: string): void {
    if (orgId) this.spentByOrg.delete(orgId);
    else this.spentByOrg.clear();
  }
}
