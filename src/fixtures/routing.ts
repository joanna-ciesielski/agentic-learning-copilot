import type { Vertical } from "../core/types";

export interface RoutingCase {
  query: string;
  expected: Vertical;
  /** Ambiguous/out-of-scope cases: `expected` is the preferred label, but these
   *  are the ones most likely to exercise the low-confidence fallback path. */
  hard?: boolean;
}

/**
 * Labeled routing fixture. Phase 1 gates on every case routing to a VALID agent
 * (validity), and reports accuracy against these labels for information. Phase 2
 * promotes accuracy to a hard CI gate against a real model.
 */
export const ROUTING_SET: RoutingCase[] = [
  // Clear courses
  { query: "Explain how photosynthesis works", expected: "courses" },
  { query: "I want to learn about neural networks", expected: "courses" },
  { query: "What is the Calvin cycle in this lesson?", expected: "courses" },
  { query: "Help me study orbital mechanics for my exam", expected: "courses" },
  { query: "Give me a tutorial on gradient descent", expected: "courses" },
  { query: "Which module covers cell biology?", expected: "courses" },
  { query: "Explain Kepler's laws", expected: "courses" },
  { query: "I need to revise algebra concepts", expected: "courses" },
  { query: "What chapter should I read to understand backpropagation?", expected: "courses" },
  { query: "Teach me the basics of chlorophyll and light reactions", expected: "courses" },

  // Clear jobs
  { query: "Show me open data analyst jobs", expected: "jobs" },
  { query: "What roles are hiring for machine learning engineers?", expected: "jobs" },
  { query: "What's the salary for a frontend developer position?", expected: "jobs" },
  { query: "I want to apply for a job at Acme", expected: "jobs" },
  { query: "Any remote openings for React developers?", expected: "jobs" },
  { query: "Help me prep for a software interview", expected: "jobs" },
  { query: "Is there an internship vacancy in data?", expected: "jobs" },
  { query: "Update my resume for an ML engineer role", expected: "jobs" },
  { query: "What positions require SQL and dashboards?", expected: "jobs" },
  { query: "Which employers are hiring analysts?", expected: "jobs" },

  // Ambiguous / mixed signal (fallback territory)
  { query: "I studied biology, what jobs can I apply to?", expected: "jobs", hard: true },
  { query: "What should I learn to get hired as an ML engineer?", expected: "courses", hard: true },
  { query: "career in astrophysics", expected: "jobs", hard: true },
  { query: "hello there", expected: "courses", hard: true },
];
