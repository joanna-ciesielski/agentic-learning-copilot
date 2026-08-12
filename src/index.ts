// Core primitives
export { HashingEmbedder, type Embedder } from "./embeddings/hashingEmbedder";
export {
  MockChatModel,
  isStreamingChatModel,
  streamOrFallback,
  type ChatModel,
  type ChatMessage,
  type Role,
  type Responder,
  type TokenChunk,
  type StreamingChatModel,
  type MockChatModelOptions,
} from "./llm/chatModel";
export { parseStructured, extractJson, StructuredOutputError } from "./core/structured";
export { type Vertical, type TenantScope, VERTICALS, isVertical } from "./core/types";

// Retrieval
export type {
  SourceDoc,
  Chunk,
  ScoredChunk,
  Citation,
  RetrievalFilter,
  Retriever,
} from "./retrieval/types";
export { tokenize, chunkDoc } from "./retrieval/text";
export { bm25Scores } from "./retrieval/bm25";
export { rrf } from "./retrieval/rrf";
export { HybridRetriever } from "./retrieval/hybridRetriever";

// Agents
export { scoreVerticals, keywordRoute } from "./agents/keywords";
export { Supervisor, RouteSchema, ROUTER_SYSTEM, DEFAULT_SCOPE, type Route, type RouteDecision } from "./agents/router";
export { VerticalAgent, makeVerticalAgent, type AgentResult } from "./agents/verticalAgent";
export { offlineResponder } from "./agents/offline";

// Graph / orchestration
export { CopilotState } from "./graph/state";
export { buildGraph, type GraphDeps } from "./graph/build";
export {
  Copilot,
  createCopilot,
  type CopilotRequest,
  type CopilotAnswer,
  type CreateCopilotOptions,
  type CopilotGuards,
  type TurnUsage,
} from "./graph/copilot";

// Streaming (contract v1.0 — docs/streaming-contract.md)
export { chunkByGraphemes, DEFAULT_CHUNK_SIZE } from "./streaming/chunking";
export {
  CopilotEventSchema,
  EnvelopeSchema,
  ThreadIdSchema,
  STREAMING_CONTRACT_VERSION,
  STREAM_EVENT_TYPES,
  STREAM_ERROR_CODES,
  TERMINAL_EVENT_TYPES,
  HEARTBEAT_INTERVAL_MS,
  RING_BUFFER_EVENTS_PER_THREAD,
  RING_BUFFER_MAX_THREADS,
  SSE_RETRY_MS,
  type CopilotEvent,
  type StreamEventType,
  type StreamErrorCode,
  type StreamEnvelope,
} from "./streaming/events";

// Self-improvement, memory, observability (Phase 4)
export { Scorer, type TurnScore } from "./agents/scorer";
export { ProfileStore, type UserProfile } from "./memory/profile";
export { InMemoryTracer, NULL_TRACER, type Tracer, type TraceEvent } from "./observability/tracer";

// Fixtures (demo/eval data)
export { CORPUS, TENANT_MARKERS } from "./fixtures/corpus";
export { ROUTING_SET, type RoutingCase } from "./fixtures/routing";
export { MULTILINGUAL_CORPUS, MULTILINGUAL_EVAL } from "./fixtures/multilingual";

// Cost discipline (Phase 3)
export { estimateTokens, estimateMessagesTokens } from "./cost/tokens";
export { PRICING, TIERS, costOf, type Tier, type TierPricing } from "./cost/pricing";
export { BudgetLedger, BudgetExceededError } from "./cost/budget";
export { CohortModelRouter, type ModelRouter, type Cohort, type Task } from "./cost/modelRouter";
export { RateLimiter } from "./cost/rateLimiter";
export { RelevanceGuard } from "./cost/relevanceGuard";
export { InMemoryMetrics, NULL_METRICS, type MetricsSink, type TurnMetric } from "./cost/metrics";
export { ResponseCache } from "./cost/cache";
export { CachingEmbedder } from "./embeddings/cachingEmbedder";
export {
  projectMonthlyCost,
  DEFAULT_ASSUMPTIONS,
  type CostAssumptions,
  type CostProjection,
} from "./cost/projection";
export {
  DefaultModelGateway,
  asGateway,
  isModelGateway,
  isStreamingGateway,
  type StreamingModelGateway,
  type ModelGateway,
  type CallContext,
  type CallUsage,
  type CompletionResult,
  type GatewayServices,
} from "./llm/modelGateway";

// Eval harness
export {
  precisionAtK,
  recallAtK,
  reciprocalRank,
  groundednessScore,
  isGrounded,
} from "./eval/metrics";
export {
  FIXTURE_VERSION,
  RETRIEVAL_EVAL,
  GROUNDEDNESS_EVAL,
  TENANCY_EVAL,
  type RetrievalCase,
  type TenancyProbe,
} from "./eval/dataset";
export { EVAL_THRESHOLDS } from "./eval/thresholds";
export { runEval, checkGates, type EvalReport, type GateResult } from "./eval/runEval";
