import {
  RING_BUFFER_EVENTS_PER_THREAD,
  RING_BUFFER_MAX_THREADS,
  type CopilotEvent,
} from "../streaming/events";

interface ThreadBuffer {
  events: CopilotEvent[];
  /** Highest seq ever dropped from this thread's buffer. The resume-gap rule
   *  (contract R4) is `lastEventId < evictedThrough` — NOT a seq-contiguity
   *  check, because heartbeats consume seq without being buffered, so buffered
   *  seqs are legitimately non-contiguous. */
  evictedThrough: number;
  lastSeq: number;
}

export type ResumeResult =
  | { kind: "replay"; events: CopilotEvent[]; complete: boolean; lastSeq: number }
  | { kind: "gap" };

/**
 * Bounded per-thread replay buffer with LRU eviction across threads (fixed
 * decision 4). In-memory and single-process by design; Postgres/Redis is the
 * documented production swap. `threadId` keys are pattern-constrained upstream
 * (contract §2) and both dimensions are bounded, so a client cannot grow this
 * without limit.
 */
export class ThreadRingBuffer {
  /** Insertion order doubles as LRU order: reads and writes re-insert. */
  private readonly threads = new Map<string, ThreadBuffer>();

  constructor(
    private readonly eventsPerThread = RING_BUFFER_EVENTS_PER_THREAD,
    private readonly maxThreads = RING_BUFFER_MAX_THREADS,
  ) {}

  /** Drop a thread's history — a fresh POST without Last-Event-ID starts a new
   *  logical stream (contract R8), and two logical streams must never share a
   *  buffer or their seq sequences would interleave. */
  reset(threadId: string): void {
    this.threads.delete(threadId);
  }

  push(event: CopilotEvent): void {
    if (event.type === "heartbeat") return; // never buffered (contract §8)
    const thread = this.ensure(event.threadId);
    thread.events.push(event);
    thread.lastSeq = event.seq;
    while (thread.events.length > this.eventsPerThread) {
      const dropped = thread.events.shift();
      if (dropped) thread.evictedThrough = dropped.seq;
    }
  }

  /** Contract R3/R4: everything after `lastEventId` if it is still buffered,
   *  else a gap. Unknown and LRU-evicted threads are gaps by the same rule —
   *  their entire history has been evicted. */
  resumeFrom(threadId: string, lastEventId: number): ResumeResult {
    const thread = this.threads.get(threadId);
    if (!thread || lastEventId < thread.evictedThrough) return { kind: "gap" };
    this.touch(threadId, thread);
    const events = thread.events.filter((e) => e.seq > lastEventId);
    const tail = thread.events.at(-1);
    return {
      kind: "replay",
      events,
      complete: tail?.type === "done" || tail?.type === "error",
      lastSeq: thread.lastSeq,
    };
  }

  get threadCount(): number {
    return this.threads.size;
  }

  private ensure(threadId: string): ThreadBuffer {
    const existing = this.threads.get(threadId);
    if (existing) {
      this.touch(threadId, existing);
      return existing;
    }
    const created: ThreadBuffer = { events: [], evictedThrough: 0, lastSeq: 0 };
    this.threads.set(threadId, created);
    while (this.threads.size > this.maxThreads) {
      const lru = this.threads.keys().next().value;
      if (lru === undefined) break;
      this.threads.delete(lru);
    }
    return created;
  }

  private touch(threadId: string, thread: ThreadBuffer): void {
    this.threads.delete(threadId);
    this.threads.set(threadId, thread);
  }
}
