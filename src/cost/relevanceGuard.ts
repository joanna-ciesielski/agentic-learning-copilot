/**
 * Anti-abuse topical-relevance guard. This is a deliberately conservative stub:
 * it rejects empty and abnormally long queries (the cheap, unambiguous abuse
 * signals) and lets everything else through, so it never false-positives on a
 * legitimate learner question. A real topical-relevance classifier is the
 * production swap behind `isRelevant`.
 */
export class RelevanceGuard {
  constructor(private readonly maxChars = 2000) {}

  isRelevant(query: string): boolean {
    const q = query.trim();
    if (q.length === 0) return false;
    if (q.length > this.maxChars) return false;
    return true;
  }
}
