/**
 * Eval gate CLI: `npm run eval`
 *
 * Runs the offline eval over the versioned fixtures, prints the report, and
 * exits non-zero if any threshold in EVAL_THRESHOLDS regresses — this is the
 * Phase-2 CI quality gate.
 */
import { MockChatModel } from "../llm/chatModel";
import { offlineResponder } from "../agents/offline";
import { CORPUS } from "../fixtures/corpus";
import { runEval, checkGates } from "./runEval";
import { EVAL_THRESHOLDS } from "./thresholds";

async function main() {
  const report = await runEval({ model: new MockChatModel(offlineResponder()), docs: CORPUS });

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`\nEval report — fixtures ${report.fixtureVersion}`);
  console.log("─".repeat(48));
  console.log(`routing accuracy     ${pct(report.routing.accuracy)}  (${report.routing.correct}/${report.routing.total})   [gate ≥ ${pct(EVAL_THRESHOLDS.routingAccuracy)}]`);
  console.log(`recall@${report.retrieval.k}             ${pct(report.retrieval.recallAtK)}  (n=${report.retrieval.total})   [gate ≥ ${pct(EVAL_THRESHOLDS.recallAtK)}]`);
  console.log(`precision@${report.retrieval.k}          ${pct(report.retrieval.precisionAtK)}  (report only)`);
  console.log(`MRR                  ${report.retrieval.mrr.toFixed(3)}  (report only)`);
  console.log(`groundedness         ${pct(report.groundedness.passRate)}  (${report.groundedness.grounded}/${report.groundedness.total}, mean ${report.groundedness.meanScore.toFixed(2)})   [gate ≥ ${pct(EVAL_THRESHOLDS.groundedness)}]`);
  console.log(`tenant isolation     ${pct(report.tenancy.isolationRate)}  (${report.tenancy.leaks} leaks / ${report.tenancy.total} probes)   [gate = 0 leaks]`);
  console.log("─".repeat(48));

  const gate = checkGates(report);
  if (gate.passed) {
    console.log("✅ all eval gates passed\n");
  } else {
    console.log("❌ eval gate FAILED:");
    for (const f of gate.failures) console.log(`   - ${f}`);
    console.log("");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
