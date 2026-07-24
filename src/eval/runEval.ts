import type { ChatModel } from "../llm/chatModel";
import type { Embedder } from "../embeddings/hashingEmbedder";
import { HashingEmbedder } from "../embeddings/hashingEmbedder";
import type { SourceDoc } from "../retrieval/types";
import { HybridRetriever } from "../retrieval/hybridRetriever";
import { Supervisor } from "../agents/router";
import { makeVerticalAgent } from "../agents/verticalAgent";
import { Copilot } from "../graph/copilot";
import { precisionAtK, recallAtK, reciprocalRank, groundednessScore } from "./metrics";
import { FIXTURE_VERSION, RETRIEVAL_EVAL, GROUNDEDNESS_EVAL, TENANCY_EVAL } from "./dataset";
import { TENANT_MARKERS } from "../fixtures/corpus";
import { ROUTING_SET } from "../fixtures/routing";
import { EVAL_THRESHOLDS } from "./thresholds";

export interface EvalReport {
  fixtureVersion: string;
  routing: { accuracy: number; correct: number; total: number };
  retrieval: { k: number; precisionAtK: number; recallAtK: number; mrr: number; total: number };
  groundedness: { passRate: number; meanScore: number; grounded: number; total: number };
  tenancy: { leaks: number; total: number; isolationRate: number };
}

export interface GateResult {
  passed: boolean;
  failures: string[];
}

function unique(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Run the full offline eval over the versioned fixtures: routing accuracy,
 * retrieval precision/recall@k + MRR against gold labels, and groundedness of
 * generated answers against their citations. Pure function of (model, docs) —
 * deterministic given the offline responder.
 */
export async function runEval(opts: {
  model: ChatModel;
  docs: SourceDoc[];
  embedder?: Embedder;
  k?: number;
}): Promise<EvalReport> {
  const k = opts.k ?? EVAL_THRESHOLDS.k;
  const embedder = opts.embedder ?? new HashingEmbedder();
  const retriever = await HybridRetriever.fromDocs(opts.docs, embedder);

  // --- Routing accuracy ---
  const supervisor = new Supervisor(opts.model);
  let correct = 0;
  for (const c of ROUTING_SET) {
    const d = await supervisor.route(c.query);
    if (d.vertical === c.expected) correct++;
  }
  const routing = { accuracy: correct / ROUTING_SET.length, correct, total: ROUTING_SET.length };

  // --- Retrieval metrics vs gold labels (document level) ---
  let pSum = 0;
  let rSum = 0;
  let mSum = 0;
  for (const c of RETRIEVAL_EVAL) {
    const hits = await retriever.retrieve(c.query, { orgId: c.orgId, vertical: c.vertical }, k);
    const docIds = unique(hits.map((h) => h.chunk.docId));
    const gold = new Set(c.gold);
    pSum += precisionAtK(docIds, gold, k);
    rSum += recallAtK(docIds, gold, k);
    mSum += reciprocalRank(docIds, gold);
  }
  const rn = RETRIEVAL_EVAL.length;
  const retrieval = { k, precisionAtK: pSum / rn, recallAtK: rSum / rn, mrr: mSum / rn, total: rn };

  // --- Groundedness of generated answers ---
  const copilot = new Copilot({
    supervisor,
    courses: makeVerticalAgent("courses", retriever, opts.model, k),
    jobs: makeVerticalAgent("jobs", retriever, opts.model, k),
  });
  const docText = new Map(opts.docs.map((d) => [d.id, d.text]));
  let gSum = 0;
  let grounded = 0;
  for (const g of GROUNDEDNESS_EVAL) {
    const res = await copilot.ask({ query: g.query, scope: { orgId: g.orgId, userId: "eval" } });
    const context = res.citations.map((c) => `${c.title} ${docText.get(c.docId) ?? ""}`);
    const score = groundednessScore(res.answer, context);
    gSum += score;
    if (score >= 0.6) grounded++;
  }
  const gn = GROUNDEDNESS_EVAL.length;
  const groundedness = { passRate: grounded / gn, meanScore: gSum / gn, grounded, total: gn };

  // --- Tenancy: probes scoped to one org but worded toward a foreign org ---
  let leaks = 0;
  for (const p of TENANCY_EVAL) {
    const res = await copilot.ask({ query: p.query, scope: { orgId: p.orgId, userId: "eval" } });
    const foreignMarkers = TENANT_MARKERS[p.foreignOrgId as keyof typeof TENANT_MARKERS] ?? [];
    const citationLeak = res.citations.some((c) => c.docId.startsWith(`${p.foreignOrgId}-`));
    const answerLeak = foreignMarkers.some((m) => res.answer.includes(m));
    if (citationLeak || answerLeak) leaks++;
  }
  const tn = TENANCY_EVAL.length;
  const tenancy = { leaks, total: tn, isolationRate: (tn - leaks) / tn };

  return { fixtureVersion: FIXTURE_VERSION, routing, retrieval, groundedness, tenancy };
}

/** Compare a report against EVAL_THRESHOLDS. Returns the list of gate failures. */
export function checkGates(report: EvalReport): GateResult {
  const failures: string[] = [];
  if (report.routing.accuracy < EVAL_THRESHOLDS.routingAccuracy) {
    failures.push(
      `routing accuracy ${report.routing.accuracy.toFixed(3)} < ${EVAL_THRESHOLDS.routingAccuracy}`,
    );
  }
  if (report.retrieval.recallAtK < EVAL_THRESHOLDS.recallAtK) {
    failures.push(
      `recall@${report.retrieval.k} ${report.retrieval.recallAtK.toFixed(3)} < ${EVAL_THRESHOLDS.recallAtK}`,
    );
  }
  if (report.groundedness.passRate < EVAL_THRESHOLDS.groundedness) {
    failures.push(
      `groundedness ${report.groundedness.passRate.toFixed(3)} < ${EVAL_THRESHOLDS.groundedness}`,
    );
  }
  if (report.tenancy.leaks > EVAL_THRESHOLDS.maxTenantLeaks) {
    failures.push(
      `tenant leakage ${report.tenancy.leaks} > ${EVAL_THRESHOLDS.maxTenantLeaks} (must be zero)`,
    );
  }
  return { passed: failures.length === 0, failures };
}
