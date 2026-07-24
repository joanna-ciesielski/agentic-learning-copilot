export interface TurnScore {
  grounded: boolean;
  citations: number;
  /** Quality signal in [0,1] fed into the self-improvement profile. */
  quality: number;
}

/**
 * Scoring agent (Zone 4). Grades a completed turn from its interaction signals —
 * whether the answer was grounded and how many citations it carried. In a real
 * deployment this also folds in explicit feedback (thumbs, dwell time); here it's
 * a deterministic function of the signals the graph already produces.
 */
export class Scorer {
  score(input: { grounded: boolean; citations: number }): TurnScore {
    const quality = input.grounded ? (input.citations > 0 ? 1 : 0.6) : 0;
    return { grounded: input.grounded, citations: input.citations, quality };
  }
}
