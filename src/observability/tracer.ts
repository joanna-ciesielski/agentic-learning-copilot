/** A single trace event in a turn's lifecycle. `data` is an arbitrary,
 *  JSON-serializable payload — what a real tracer would attach to a span. */
export interface TraceEvent {
  type: string;
  data?: Record<string, unknown>;
}

/** Tracing hook. A production build implements this against LangSmith / PostHog /
 *  OpenTelemetry; the app only depends on `emit`. */
export interface Tracer {
  emit(event: TraceEvent): void;
}

/** No-op tracer (default when tracing isn't wired). */
export const NULL_TRACER: Tracer = { emit() {} };

/** In-memory tracer for tests/demos — retains events and can filter by type. */
export class InMemoryTracer implements Tracer {
  readonly events: TraceEvent[] = [];

  emit(event: TraceEvent): void {
    this.events.push(event);
  }

  ofType(type: string): TraceEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}
