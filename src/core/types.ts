/** The vertical agents the supervisor can route to. Single source of truth:
 *  the `Vertical` type, the zod router enum, and `isVertical` all derive from
 *  this tuple, so adding a vertical is a one-line change here. */
export const VERTICALS = ["courses", "jobs"] as const;

export type Vertical = (typeof VERTICALS)[number];

export function isVertical(v: unknown): v is Vertical {
  return typeof v === "string" && (VERTICALS as readonly string[]).includes(v);
}

/**
 * Tenant + user scope carried on every request. `orgId` is the hard isolation
 * boundary: retrieval must never return another org's content, so this is passed
 * into every store query as a filter, not applied afterwards.
 */
export interface TenantScope {
  orgId: string;
  userId: string;
}
