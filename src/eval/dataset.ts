import type { Vertical } from "../core/types";

/**
 * Fixture version. Bump on any change to the corpus, routing set, or retrieval
 * labels. The eval report records this so a metric shift is attributable to a
 * fixture change vs. a code change.
 */
export const FIXTURE_VERSION = "2026.07.1";

/**
 * Retrieval eval case: a scoped query with gold (relevant) source-document ids.
 * Queries are worded to overlap their gold docs lexically — a legitimate
 * fixture-eval design, since the point is a stable regression signal on the
 * retrieval pipeline, not to prove semantic search on a toy hashing embedder.
 */
export interface RetrievalCase {
  id: string;
  orgId: string;
  vertical: Vertical;
  query: string;
  gold: string[];
}

export const RETRIEVAL_EVAL: RetrievalCase[] = [
  // ACME — Courses
  { id: "r-acme-c-1", orgId: "acme", vertical: "courses", query: "chlorophyll light reactions and the calvin cycle", gold: ["acme-course-photosynthesis"] },
  { id: "r-acme-c-2", orgId: "acme", vertical: "courses", query: "backpropagation gradient descent weighted layers", gold: ["acme-course-neuralnets"] },
  { id: "r-acme-c-3", orgId: "acme", vertical: "courses", query: "mitochondria atp krebs cycle glycolysis", gold: ["acme-course-respiration"] },
  { id: "r-acme-c-4", orgId: "acme", vertical: "courses", query: "matrix eigenvalues eigenvectors determinant", gold: ["acme-course-linalg"] },
  { id: "r-acme-c-5", orgId: "acme", vertical: "courses", query: "mean variance standard deviation normal distribution", gold: ["acme-course-stats"] },

  // ACME — Jobs
  { id: "r-acme-j-1", orgId: "acme", vertical: "jobs", query: "dashboards sql reporting analyst", gold: ["acme-job-data-analyst"] },
  { id: "r-acme-j-2", orgId: "acme", vertical: "jobs", query: "deploy models training pipelines mlops", gold: ["acme-job-ml-engineer"] },
  { id: "r-acme-j-3", orgId: "acme", vertical: "jobs", query: "experiments a/b testing predictive models", gold: ["acme-job-data-scientist"] },
  { id: "r-acme-j-4", orgId: "acme", vertical: "jobs", query: "apis database schemas backend services", gold: ["acme-job-backend"] },

  // GLOBEX — Courses
  { id: "r-globex-c-1", orgId: "globex", vertical: "courses", query: "kepler elliptical orbit semi-major axis gravity", gold: ["globex-course-orbital"] },
  { id: "r-globex-c-2", orgId: "globex", vertical: "courses", query: "entropy heat energy conservation thermodynamics", gold: ["globex-course-thermo"] },
  { id: "r-globex-c-3", orgId: "globex", vertical: "courses", query: "derivative integral limit rate of change", gold: ["globex-course-calculus"] },
  { id: "r-globex-c-4", orgId: "globex", vertical: "courses", query: "carbon molecules functional groups carbonyl", gold: ["globex-course-orgchem"] },

  // GLOBEX — Jobs
  { id: "r-globex-j-1", orgId: "globex", vertical: "jobs", query: "react typescript accessible interfaces design systems", gold: ["globex-job-frontend"] },
  { id: "r-globex-j-2", orgId: "globex", vertical: "jobs", query: "ci cd kubernetes infrastructure deployments", gold: ["globex-job-devops"] },
  { id: "r-globex-j-3", orgId: "globex", vertical: "jobs", query: "roadmap stakeholders prioritize features product", gold: ["globex-job-pm"] },
];

/**
 * Groundedness eval reuses the retrieval queries (all answerable) plus their
 * scope. The harness runs the full copilot and checks the answer is supported by
 * its cited documents.
 */
export const GROUNDEDNESS_EVAL = RETRIEVAL_EVAL.map((c) => ({
  id: c.id,
  orgId: c.orgId,
  query: c.query,
}));

/**
 * Tenancy probes: each query is scoped to `orgId` but worded to target the
 * FOREIGN tenant's content. Correct behavior is that nothing from `foreignOrgId`
 * appears in the answer or its citations — leakage must be zero.
 */
export interface TenancyProbe {
  id: string;
  orgId: string;
  foreignOrgId: string;
  query: string;
}

export const TENANCY_EVAL: TenancyProbe[] = [
  { id: "t-1", orgId: "acme", foreignOrgId: "globex", query: "kepler elliptical orbit semi-major axis gravity" },
  { id: "t-2", orgId: "acme", foreignOrgId: "globex", query: "react typescript accessible interfaces design systems" },
  { id: "t-3", orgId: "globex", foreignOrgId: "acme", query: "chlorophyll light reactions calvin cycle glucose" },
  { id: "t-4", orgId: "globex", foreignOrgId: "acme", query: "dashboards sql reporting junior analyst" },
];
