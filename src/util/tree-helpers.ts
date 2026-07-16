/** Pure helpers for the tickets tree — no vscode import, so unit-testable. */

export type TicketScope = "activeSprint" | "allOpen";

/**
 * Label for the tickets section. Reflects what is ACTUALLY shown: when the
 * active-sprint filter was requested but the board has no sprints, we fall back
 * to all-open and must say so rather than mislabel the list.
 */
export function scopeSectionLabel(scope: TicketScope, sprintFilterApplied = true): string {
  if (scope === "allOpen") {
    return "All Open Tickets";
  }
  return sprintFilterApplied ? "My Active Sprint" : "All Open Tickets (no sprints)";
}

/** The scope you land on when toggling. */
export function nextScope(scope: TicketScope): TicketScope {
  return scope === "activeSprint" ? "allOpen" : "activeSprint";
}

/** Map a Jira issue type to a themed codicon id. */
export function iconForType(type: string): string {
  const t = (type || "").toLowerCase();
  if (t.includes("bug")) return "bug";
  if (t.includes("story")) return "book";
  if (t.includes("epic")) return "milestone";
  if (t.includes("sub")) return "list-tree";
  return "issue-opened";
}

/** Map a Jira issue type to a subtle theme color id for its icon. */
export function colorForType(type: string): string {
  const t = (type || "").toLowerCase();
  if (t.includes("bug")) return "charts.red";
  if (t.includes("story")) return "charts.green";
  if (t.includes("epic")) return "charts.purple";
  if (t.includes("sub")) return "charts.orange";
  return "charts.blue";
}

/** Extract a ticket key from a tree node argument (or a raw string). */
export function keyFromArg(arg: unknown): string | undefined {
  if (typeof arg === "string") {
    return arg;
  }
  const node = arg as { issue?: { key?: string } } | undefined;
  return node?.issue?.key;
}

// ---- branch awareness -------------------------------------------------------

/**
 * Does a branch name reference this ticket key?
 *
 * Uses boundaries rather than a bare substring test: "LPB-1" must NOT match
 * "feature/LPB-12-x". The key has to be followed by a non-digit (or end of
 * string) and preceded by a non-alphanumeric (or start).
 */
export function branchMatchesTicket(branch: string, key: string): boolean {
  if (!branch || !key) {
    return false;
  }
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^0-9]|$)`, "i").test(branch);
}

/** Map each ticket key to the local branches that reference it. */
export function mapTicketBranches(
  branches: string[],
  keys: string[]
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    const hits = branches.filter((b) => branchMatchesTicket(b, key));
    if (hits.length) {
      out[key] = hits;
    }
  }
  return out;
}

// ---- row decoration ---------------------------------------------------------

/**
 * Compact relative age, e.g. "just now", "5m", "3h", "2d", "4w".
 * Returns undefined for missing/unparseable input rather than guessing.
 */
export function relativeTime(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) {
    return undefined;
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return undefined;
  }
  const secs = Math.floor((now.getTime() - then) / 1000);
  if (secs < 0) {
    return "just now";
  }
  if (secs < 60) {
    return "just now";
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 52) {
    return `${weeks}w`;
  }
  return `${Math.floor(days / 365)}y`;
}

/**
 * Only surface priority when it carries information. Every ticket being
 * "Medium" is noise, so the default (and missing) values are hidden.
 */
export function notablePriority(priority: string | undefined): string | undefined {
  if (!priority) {
    return undefined;
  }
  const p = priority.trim();
  if (!p || /^(medium|none|normal|undefined)$/i.test(p)) {
    return undefined;
  }
  return p;
}

// ---- status grouping --------------------------------------------------------

export interface StatusGroup {
  status: string;
  category?: string;
  issues: { status: string }[];
}

/** In-progress work first, then to-do, then done — the order you care about. */
export function statusCategoryRank(category: string | undefined): number {
  switch ((category || "").toLowerCase()) {
    case "indeterminate":
      return 0; // In Progress
    case "new":
      return 1; // To Do
    case "done":
      return 2;
    default:
      return 3;
  }
}

/** Group issues by status name, ordered by category then alphabetically. */
export function groupIssuesByStatus<T extends { status: string; statusCategory?: string }>(
  issues: T[]
): { status: string; category?: string; issues: T[] }[] {
  const map = new Map<string, { status: string; category?: string; issues: T[] }>();
  for (const issue of issues) {
    const status = issue.status || "No status";
    let g = map.get(status);
    if (!g) {
      g = { status, category: issue.statusCategory, issues: [] };
      map.set(status, g);
    }
    g.issues.push(issue);
  }
  return [...map.values()].sort((a, b) => {
    const r = statusCategoryRank(a.category) - statusCategoryRank(b.category);
    return r !== 0 ? r : a.status.localeCompare(b.status);
  });
}

/** Grouping a single status just adds a pointless click. */
export function shouldGroupByStatus<T extends { status: string }>(issues: T[]): boolean {
  return new Set(issues.map((i) => i.status || "No status")).size > 1;
}

/**
 * Extract the known ticket fields from a tree node argument, so a details view
 * can render immediately from what the sidebar already has (and still work if
 * the follow-up fetch fails). Falls back to a bare key for string arguments.
 */
export function ticketFromArg(
  arg: unknown
): { key: string; summary?: string; issueType?: string; status?: string } | undefined {
  if (typeof arg === "string") {
    return arg ? { key: arg } : undefined;
  }
  const issue = (arg as { issue?: { key?: string; summary?: string; issueType?: string; status?: string } })
    ?.issue;
  if (!issue?.key) {
    return undefined;
  }
  return {
    key: issue.key,
    summary: issue.summary,
    issueType: issue.issueType,
    status: issue.status,
  };
}
