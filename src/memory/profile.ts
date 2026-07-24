import { VERTICALS, type Vertical, type TenantScope } from "../core/types";

/**
 * Compact per-user profile (the `user.md` analog). Tracks how many grounded
 * answers each vertical has produced for this user, plus a turn count. Kept
 * intentionally small — a routing prior, not a full history.
 */
export interface UserProfile {
  orgId: string;
  userId: string;
  grounded: Record<Vertical, number>;
  turns: number;
}

function emptyProfile(scope: TenantScope): UserProfile {
  return { orgId: scope.orgId, userId: scope.userId, grounded: { courses: 0, jobs: 0 }, turns: 0 };
}

/**
 * In-memory per-user profile store, keyed by `${orgId}:${userId}` (tenant-scoped
 * — profiles never cross orgs). This is the Zone-4 memory: dev uses this Map, and
 * a production build swaps in Redis/Postgres behind the same interface.
 */
export class ProfileStore {
  private readonly map = new Map<string, UserProfile>();

  private key(scope: TenantScope): string {
    return `${scope.orgId}:${scope.userId}`;
  }

  /** Read a profile WITHOUT creating one — a pure read never mutates the store.
   *  Returns a fresh (unstored) empty profile for an unseen user. */
  get(scope: TenantScope): UserProfile {
    return this.map.get(this.key(scope)) ?? emptyProfile(scope);
  }

  /** Get-or-create the stored, mutable profile (write path only). */
  private ensure(scope: TenantScope): UserProfile {
    const k = this.key(scope);
    let p = this.map.get(k);
    if (!p) {
      p = emptyProfile(scope);
      this.map.set(k, p);
    }
    return p;
  }

  /** Record the outcome of a turn: increment turns, and (if grounded) the count
   *  for the vertical that answered. This is the write side of the loop. */
  record(scope: TenantScope, vertical: Vertical, grounded: boolean): void {
    const p = this.ensure(scope);
    p.turns += 1;
    if (grounded) p.grounded[vertical] += 1;
  }

  /**
   * The routing prior read by the supervisor on later turns: the vertical this
   * user's grounded answers have favored, once there's enough signal. Generalizes
   * over all VERTICALS (argmax with a margin over the runner-up), so adding a
   * vertical needs no change here. Returns null when the profile is too thin or
   * the top two are close, so the prior only fires when it's informative.
   */
  preferredVertical(scope: TenantScope, minTurns = 2, minMargin = 1): Vertical | null {
    const p = this.get(scope);
    if (p.turns < minTurns) return null;
    const ranked = [...VERTICALS].sort((x, y) => p.grounded[y] - p.grounded[x]);
    const top = ranked[0];
    if (!top) return null;
    const runnerUp = ranked[1];
    const margin = p.grounded[top] - (runnerUp ? p.grounded[runnerUp] : 0);
    return margin >= minMargin ? top : null;
  }
}
