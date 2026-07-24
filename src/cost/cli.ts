/**
 * Cost projection CLI: `npm run cost`
 *
 * Prints a monthly cost estimate for the posting's "~10K learners" ask using the
 * default assumptions, with a per-tier breakdown. Every input is explicit in
 * DEFAULT_ASSUMPTIONS so the number is defensible and re-runnable.
 */
import { projectMonthlyCost, DEFAULT_ASSUMPTIONS } from "./projection";
import { TIERS } from "./pricing";

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function main() {
  const a = DEFAULT_ASSUMPTIONS;
  const p = projectMonthlyCost(a);

  console.log(`\nMonthly cost projection`);
  console.log("─".repeat(52));
  console.log(`users                 ${a.users.toLocaleString()}`);
  console.log(`sessions/user/mo      ${a.sessionsPerUserPerMonth}`);
  console.log(`turns/session         ${a.turnsPerSession}`);
  console.log(`tokens/turn           ${a.promptTokensPerTurn} in / ${a.completionTokensPerTurn} out`);
  console.log(`cache hit rate        ${(a.cacheHitRate * 100).toFixed(0)}%`);
  console.log("─".repeat(52));
  console.log(`total turns/mo        ${Math.round(p.totalTurns).toLocaleString()}`);
  console.log(`billed turns/mo       ${Math.round(p.billedTurns).toLocaleString()}  (after cache)`);
  console.log("─".repeat(52));
  for (const tier of TIERS) {
    const share = ((a.tierMix[tier] ?? 0) * 100).toFixed(0);
    console.log(`  ${tier.padEnd(10)} ${String(share).padStart(3)}%   ${usd(p.byTier[tier])}`);
  }
  console.log("─".repeat(52));
  console.log(`monthly total         ${usd(p.monthlyUsd)}`);
  console.log(`per user / mo         ${usd(p.perUserUsd)}\n`);
}

main();
