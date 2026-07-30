/**
 * How loudly to render an urgent issue.
 *
 * This lives in the UI layer rather than the repository because it is a
 * presentation decision, not a fact about the data. The database records what
 * the model found; how alarming that should look on a dashboard is a judgement
 * that could reasonably differ per screen, and the repository has no business
 * making it. Keeping it here also keeps a Client Component from having to
 * import a `server-only` module to render a badge.
 *
 * Deliberately conservative. If everything reads as High the section stops
 * being a priority list and becomes a wall of red that people learn to skip —
 * the failure mode the phase specification called out by name. Negative
 * sentiment *and* more than one finding is the only combination that earns it.
 */

export type Severity = "low" | "medium" | "high";

export function severityOf(issue: {
  issues: readonly string[];
  sentiment: string | null;
}): Severity {
  const many = issue.issues.length >= 2;
  const negative = issue.sentiment === "negative";

  if (negative && many) return "high";
  if (negative || many) return "medium";
  return "low";
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};
