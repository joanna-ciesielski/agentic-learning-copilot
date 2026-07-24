/**
 * Offline demo CLI: `npm run demo -- --org acme "explain photosynthesis"`
 *
 * Wires the fixture corpus into a Copilot driven by the offline responder (no
 * keys, no network) and prints the route, answer, citations, and observability
 * notes. This is the Zone-1 "surface" in its simplest form.
 */
import { MockChatModel } from "./llm/chatModel";
import { offlineResponder } from "./agents/offline";
import { createCopilot } from "./graph/copilot";
import { CORPUS } from "./fixtures/corpus";

function parseArgs(argv: string[]): { org: string; query: string } {
  let org = "acme";
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org") org = argv[++i] ?? org;
    else rest.push(argv[i]!);
  }
  return { org, query: rest.join(" ").trim() || "Explain how photosynthesis works" };
}

async function main() {
  const { org, query } = parseArgs(process.argv.slice(2));
  const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
  const res = await copilot.ask({ query, scope: { orgId: org, userId: "demo-user" } });

  console.log(`\nquery:    ${res.query}`);
  console.log(`org:      ${org}`);
  console.log(
    res.route
      ? `route:    ${res.route.vertical} (confidence ${res.route.confidence}, fallback=${res.route.viaFallback})`
      : `route:    (declined)`,
  );
  console.log(`answer:   ${res.answer}`);
  console.log(`citations: ${res.citations.map((c) => c.title).join(" | ") || "(none)"}`);
  console.log(`usage:    ${res.usage.totalTokens} tok, $${res.usage.costUsd.toFixed(5)}, tiers=[${res.usage.tiers.join(",")}]`);
  console.log(`notes:    ${res.notes.join(", ")}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
