/**
 * Pure helpers for matching a user-configured target status/transition name
 * against the transitions Jira reports for an issue. Jira workflows vary wildly,
 * so we match forgivingly: exact destination-status name first, then exact
 * transition name, then partial matches.
 */

export interface JiraTransition {
  id: string;
  name: string;       // the transition's own name, e.g. "Start Progress"
  toStatus?: string;  // the resulting status name, e.g. "In Progress"
}

export function pickTransition(
  transitions: JiraTransition[],
  target: string
): JiraTransition | undefined {
  const t = (target || "").trim().toLowerCase();
  if (!t) {
    return undefined;
  }
  const byStatusExact = transitions.find((x) => (x.toStatus ?? "").toLowerCase() === t);
  if (byStatusExact) {
    return byStatusExact;
  }
  const byNameExact = transitions.find((x) => x.name.toLowerCase() === t);
  if (byNameExact) {
    return byNameExact;
  }
  const byStatusPartial = transitions.find((x) => (x.toStatus ?? "").toLowerCase().includes(t));
  if (byStatusPartial) {
    return byStatusPartial;
  }
  return transitions.find((x) => x.name.toLowerCase().includes(t));
}

/** Human-readable list of what the ticket *can* transition to, for error messages. */
export function describeTransitions(transitions: JiraTransition[]): string {
  const names = transitions.map((x) => x.toStatus || x.name).filter(Boolean);
  return names.length ? names.join(", ") : "(none available)";
}
