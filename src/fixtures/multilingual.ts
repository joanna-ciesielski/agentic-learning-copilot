import type { SourceDoc } from "../retrieval/types";

/**
 * Bilingual (Arabic + English) fixture for one tenant ("meydan"). Each vertical
 * holds a parallel Arabic doc and English doc so a query in either language should
 * retrieve the same-language document. This exercises the Unicode tokenizer and
 * the language-agnostic embedder/BM25 path end to end. Note: retrieval quality on
 * a toy hashing embedder is lexical, not semantic — a production build uses an
 * Arabic-capable embedding model (and reports transcript WER for spoken content).
 */
export const MULTILINGUAL_CORPUS: SourceDoc[] = [
  {
    id: "meydan-course-photosynthesis-ar",
    orgId: "meydan",
    vertical: "courses",
    title: "التمثيل الضوئي",
    text: `التمثيل الضوئي هو تحويل الطاقة الضوئية إلى طاقة كيميائية مخزنة في الجلوكوز.

يمتص الكلوروفيل الضوء في الصانعات الخضراء وينتج الأكسجين من الماء.`,
  },
  {
    id: "meydan-course-databases-en",
    orgId: "meydan",
    vertical: "courses",
    title: "Databases 101",
    text: `A relational database stores data in tables with rows and columns.

Indexes speed up queries; SQL is the language used to read and write the data.`,
  },
  {
    id: "meydan-job-frontend-ar",
    orgId: "meydan",
    vertical: "jobs",
    title: "مطور واجهات أمامية",
    text: `تبحث الشركة عن مطور واجهات أمامية لبناء واجهات تفاعلية باستخدام رياكت.

المتطلبات: جافاسكريبت وتايب سكريبت وخبرة في تصميم الواجهات.`,
  },
  {
    id: "meydan-job-datascientist-en",
    orgId: "meydan",
    vertical: "jobs",
    title: "Data Scientist",
    text: `We are hiring a data scientist to build predictive models and run experiments.

Requirements: statistics, Python, and machine learning experience.`,
  },
];

/** Bilingual retrieval probes: query language should match the retrieved doc. */
export const MULTILINGUAL_EVAL = [
  { orgId: "meydan", vertical: "courses" as const, query: "الكلوروفيل والضوء والأكسجين", gold: "meydan-course-photosynthesis-ar" },
  { orgId: "meydan", vertical: "courses" as const, query: "sql tables rows and indexes", gold: "meydan-course-databases-en" },
  { orgId: "meydan", vertical: "jobs" as const, query: "مطور واجهات رياكت وجافاسكريبت", gold: "meydan-job-frontend-ar" },
  { orgId: "meydan", vertical: "jobs" as const, query: "predictive models python statistics", gold: "meydan-job-datascientist-en" },
];
