import type { SourceDoc } from "../retrieval/types";

/**
 * Two-tenant fixture corpus. Tenants "acme" and "globex" each own several
 * Courses and Jobs documents. Content is deliberately tenant-distinct (note the
 * unique marker tokens like ACME-CB-777 / GLOBEX-OM-888) so tenant-isolation
 * tests can assert one org's query never surfaces another org's material. The
 * corpus is intentionally sized with multiple docs per (tenant, vertical) so
 * top-k retrieval metrics are meaningful (real distractors, not a single answer).
 */
export const CORPUS: SourceDoc[] = [
  // ---------- ACME — Courses ----------
  {
    id: "acme-course-photosynthesis",
    orgId: "acme",
    vertical: "courses",
    title: "Photosynthesis Basics (ACME-CB-777)",
    text: `Photosynthesis converts light energy into chemical energy stored as glucose.

The light-dependent reactions occur in the thylakoid membranes, where chlorophyll absorbs light and water is split to release oxygen.

The Calvin cycle then fixes carbon dioxide into sugar using ATP and NADPH produced by the light reactions. Marker: ACME-CB-777.`,
  },
  {
    id: "acme-course-neuralnets",
    orgId: "acme",
    vertical: "courses",
    title: "Intro to Neural Networks",
    text: `A neural network is a stack of layers that transform inputs into outputs through weighted connections and nonlinear activations.

Training uses backpropagation: compute a loss, then adjust weights via gradient descent to reduce it over many epochs.`,
  },
  {
    id: "acme-course-respiration",
    orgId: "acme",
    vertical: "courses",
    title: "Cellular Respiration",
    text: `Cellular respiration releases energy from glucose to produce ATP inside the mitochondria.

Glycolysis splits glucose into pyruvate; the Krebs cycle and the electron transport chain then generate most of the ATP.`,
  },
  {
    id: "acme-course-linalg",
    orgId: "acme",
    vertical: "courses",
    title: "Linear Algebra Foundations",
    text: `Linear algebra studies vectors, matrices, and the linear transformations between them.

Key ideas include matrix multiplication, the determinant, eigenvalues, and eigenvectors, which underpin much of machine learning.`,
  },
  {
    id: "acme-course-stats",
    orgId: "acme",
    vertical: "courses",
    title: "Statistics Basics",
    text: `Descriptive statistics summarize data with the mean, variance, and standard deviation.

A probability distribution describes how likely each outcome is; the normal distribution is central to inference and hypothesis testing.`,
  },

  // ---------- ACME — Jobs ----------
  {
    id: "acme-job-data-analyst",
    orgId: "acme",
    vertical: "jobs",
    title: "Junior Data Analyst at Acme (ACME-JOB-501)",
    text: `Acme is hiring a Junior Data Analyst. Responsibilities: build dashboards, run SQL queries, and support reporting.

Requirements: SQL, spreadsheets, and basic statistics. Salary range 60k-75k. Reference: ACME-JOB-501.`,
  },
  {
    id: "acme-job-ml-engineer",
    orgId: "acme",
    vertical: "jobs",
    title: "Machine Learning Engineer at Acme",
    text: `Acme seeks an ML Engineer to deploy models to production, build training pipelines, and monitor model quality.

Requirements: Python, PyTorch or TensorFlow, and MLOps experience. Remote-friendly.`,
  },
  {
    id: "acme-job-data-scientist",
    orgId: "acme",
    vertical: "jobs",
    title: "Data Scientist at Acme",
    text: `Acme is hiring a Data Scientist to design experiments, run A/B testing, and build predictive models that inform product decisions.

Requirements: statistics, Python, and experimentation. Strong communication for stakeholder reporting.`,
  },
  {
    id: "acme-job-backend",
    orgId: "acme",
    vertical: "jobs",
    title: "Backend Engineer at Acme",
    text: `Acme needs a Backend Engineer to build and operate APIs, database schemas, and backend services at scale.

Requirements: Node or Python, SQL databases, and REST API design. On-call rotation.`,
  },

  // ---------- GLOBEX — Courses ----------
  {
    id: "globex-course-orbital",
    orgId: "globex",
    vertical: "courses",
    title: "Orbital Mechanics 101 (GLOBEX-OM-888)",
    text: `Orbital mechanics studies the motion of objects under gravity. A stable orbit balances gravitational pull against tangential velocity.

Kepler's laws describe elliptical orbits, equal areas in equal times, and the relationship between orbital period and semi-major axis. Marker: GLOBEX-OM-888.`,
  },
  {
    id: "globex-course-thermo",
    orgId: "globex",
    vertical: "courses",
    title: "Thermodynamics Essentials",
    text: `Thermodynamics describes how heat and energy move through systems.

The first law is conservation of energy; the second law states that entropy in an isolated system never decreases.`,
  },
  {
    id: "globex-course-calculus",
    orgId: "globex",
    vertical: "courses",
    title: "Calculus I",
    text: `Calculus studies continuous change through limits, derivatives, and integrals.

The derivative measures an instantaneous rate of change; the integral accumulates quantities and is the inverse operation under the fundamental theorem.`,
  },
  {
    id: "globex-course-orgchem",
    orgId: "globex",
    vertical: "courses",
    title: "Organic Chemistry Intro",
    text: `Organic chemistry studies carbon-based molecules and their reactions.

Functional groups such as hydroxyl, carbonyl, and carboxyl determine how molecules behave and bond.`,
  },

  // ---------- GLOBEX — Jobs ----------
  {
    id: "globex-job-frontend",
    orgId: "globex",
    vertical: "jobs",
    title: "Frontend Developer at Globex (GLOBEX-JOB-909)",
    text: `Globex is hiring a Frontend Developer to build accessible React interfaces and design systems.

Requirements: TypeScript, React, and CSS. Salary range 90k-120k. Reference: GLOBEX-JOB-909.`,
  },
  {
    id: "globex-job-devops",
    orgId: "globex",
    vertical: "jobs",
    title: "DevOps Engineer at Globex",
    text: `Globex needs a DevOps Engineer to own CI/CD pipelines, Kubernetes infrastructure, and cloud deployments.

Requirements: Docker, Kubernetes, and infrastructure-as-code. Reliability and on-call ownership.`,
  },
  {
    id: "globex-job-pm",
    orgId: "globex",
    vertical: "jobs",
    title: "Product Manager at Globex",
    text: `Globex is hiring a Product Manager to define the roadmap, align stakeholders, and prioritize features from discovery to launch.

Requirements: product discovery, communication, and data-informed prioritization.`,
  },
];

/** Unique marker tokens per tenant, handy for leakage assertions in tests. */
export const TENANT_MARKERS = {
  acme: ["ACME-CB-777", "ACME-JOB-501"],
  globex: ["GLOBEX-OM-888", "GLOBEX-JOB-909"],
} as const;
