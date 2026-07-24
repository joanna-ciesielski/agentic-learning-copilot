import type { Vertical } from "../core/types";
import { tokenize } from "../retrieval/text";

const COURSE_KW = new Set([
  "course", "courses", "lesson", "lessons", "learn", "learning", "study", "studying",
  "concept", "tutorial", "module", "explain", "understand", "topic", "chapter", "quiz",
  "biology", "cell", "photosynthesis", "math", "algebra", "physics", "orbit", "neural",
  "syllabus", "curriculum", "exam", "revise",
]);

const JOB_KW = new Set([
  "job", "jobs", "role", "roles", "hiring", "hire", "apply", "application", "salary",
  "position", "career", "careers", "resume", "cv", "interview", "vacancy", "opening",
  "employer", "posting", "recruiter", "internship", "compensation", "remote", "onsite",
]);

/** Count query tokens matching each vertical's keyword set. Deterministic; used
 *  by both the offline classifier stand-in and the supervisor's fallback. */
export function scoreVerticals(query: string): { courses: number; jobs: number } {
  let courses = 0;
  let jobs = 0;
  for (const t of tokenize(query)) {
    if (COURSE_KW.has(t)) courses++;
    if (JOB_KW.has(t)) jobs++;
  }
  return { courses, jobs };
}

/** Deterministic keyword router. Always returns a VALID vertical (defaults to
 *  "courses" on a tie or no signal), which is what guarantees the supervisor can
 *  never route to an invalid agent even when the model output is unusable. */
export function keywordRoute(query: string): Vertical {
  const { courses, jobs } = scoreVerticals(query);
  return jobs > courses ? "jobs" : "courses";
}
