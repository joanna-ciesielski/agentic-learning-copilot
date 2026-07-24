import type { Tier } from "./pricing";

/** Cohorts drive tier selection: paid users get the best model, unverified/anon
 *  users get the cheapest (also an abuse/cost control). */
export type Cohort = "paid" | "general" | "unverified";

/** What the model call is for. Routing is a cheap structural classification and
 *  never needs a frontier model; answering can. */
export type Task = "route" | "answer";

export interface ModelRouter {
  pickModel(cohort: Cohort, task: Task): Tier;
}

/**
 * Deterministic multi-tier policy:
 *  - routing → never frontier (mid for known users, cheap for unverified);
 *  - answering → frontier for paid, mid for general, cheap for unverified.
 * Centralizing the policy makes the cost/quality trade-off explicit and testable.
 */
export class CohortModelRouter implements ModelRouter {
  pickModel(cohort: Cohort, task: Task): Tier {
    if (task === "route") return cohort === "unverified" ? "cheap" : "mid";
    if (cohort === "paid") return "frontier";
    if (cohort === "general") return "mid";
    return "cheap";
  }
}
