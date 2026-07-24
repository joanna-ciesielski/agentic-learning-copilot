import type { Tier } from "./pricing";
import type { Task } from "./modelRouter";

/** One model-call observation. This is the payload a real sink (PostHog,
 *  LangSmith, a metrics DB) would receive per call. */
export interface TurnMetric {
  requestId: string;
  orgId: string;
  userId: string;
  task: Task;
  tier: Tier;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  cached: boolean;
}

export interface MetricsSink {
  record(metric: TurnMetric): void;
}

/** No-op sink (default when observability isn't wired). */
export const NULL_METRICS: MetricsSink = { record() {} };

/** In-memory sink for tests/demos, with a rollup. A production sink would forward
 *  events to PostHog/LangSmith instead of retaining them. */
export class InMemoryMetrics implements MetricsSink {
  readonly events: TurnMetric[] = [];

  record(metric: TurnMetric): void {
    this.events.push(metric);
  }

  summary(): {
    calls: number;
    totalTokens: number;
    costUsd: number;
    cacheHits: number;
    avgLatencyMs: number;
    byTier: Record<string, number>;
  } {
    const calls = this.events.length;
    let totalTokens = 0;
    let costUsd = 0;
    let cacheHits = 0;
    let latency = 0;
    const byTier: Record<string, number> = {};
    for (const e of this.events) {
      totalTokens += e.totalTokens;
      costUsd += e.costUsd;
      if (e.cached) cacheHits++;
      latency += e.latencyMs;
      byTier[e.tier] = (byTier[e.tier] ?? 0) + 1;
    }
    return {
      calls,
      totalTokens,
      costUsd,
      cacheHits,
      avgLatencyMs: calls ? latency / calls : 0,
      byTier,
    };
  }
}
