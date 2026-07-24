/**
 * Per-user request cap (anti-abuse + cost control). In-memory counter keyed by
 * userId. "Daily" is illustrative: production keys by `${userId}:${utcDate}` and
 * uses a TTL store; here `reset()` stands in for the daily rollover.
 */
export class RateLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxPerUser: number) {}

  /** Consume one unit of quota; returns false (without consuming) if at the cap. */
  tryConsume(userId: string): boolean {
    const used = this.counts.get(userId) ?? 0;
    if (used >= this.maxPerUser) return false;
    this.counts.set(userId, used + 1);
    return true;
  }

  used(userId: string): number {
    return this.counts.get(userId) ?? 0;
  }

  reset(userId?: string): void {
    if (userId) this.counts.delete(userId);
    else this.counts.clear();
  }
}
