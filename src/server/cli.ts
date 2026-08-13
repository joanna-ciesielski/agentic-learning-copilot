import { createCopilotServer } from "./index";
import { createCopilot } from "../graph/copilot";
import { MockChatModel } from "../llm/chatModel";
import { offlineResponder } from "../agents/offline";
import { CORPUS } from "../fixtures/corpus";
import { MULTILINGUAL_CORPUS } from "../fixtures/multilingual";
import { BudgetLedger } from "../cost/budget";
import { RateLimiter } from "../cost/rateLimiter";
import { RelevanceGuard } from "../cost/relevanceGuard";

/**
 * `npm run serve` — the offline demo server. Same posture as the CLI demo:
 * deterministic mock model, fixture corpus, no keys, no network. The mock
 * streams with a small inter-chunk delay so tokens visibly arrive.
 */
async function main(): Promise<void> {
  const copilot = await createCopilot({
    model: new MockChatModel(offlineResponder(), { delayMs: 15 }),
    docs: [...CORPUS, ...MULTILINGUAL_CORPUS],
    budget: new BudgetLedger(200_000),
    rateLimiter: new RateLimiter(500),
    relevanceGuard: new RelevanceGuard(),
  });

  const port = Number(process.env.PORT ?? 3000);
  const server = createCopilotServer({ copilot });
  server.listen(port, () => {
    console.log(`SSE streaming server listening on http://localhost:${port}`);
    console.log(`Contract: docs/streaming-contract.md v1.0 — POST /v1/chat`);
    console.log(`Try:`);
    console.log(
      `  curl -N -X POST http://localhost:${port}/v1/chat \\\n` +
        `    -H 'content-type: application/json' \\\n` +
        `    -d '{"query":"explain photosynthesis","scope":{"orgId":"acme","userId":"u1"},"threadId":"t-demo"}'`,
    );
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
