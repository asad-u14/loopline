/**
 * Pure text helpers for building and parsing branch names and commit messages.
 * These have no VS Code dependency so they are trivial to unit-test.
 */

/** A parsed Jira ticket key, e.g. { project: "LPB", number: "1234", key: "LPB-1234" }. */
export interface TicketKey {
  project: string;
  number: string;
  key: string;
}

/** The pieces we can recover from a branch name that follows our convention. */
export interface ParsedBranch {
  prefix: string;      // e.g. "feature" | "bugfix"
  ticket: string;      // e.g. "LPB-1234"
  slug: string;        // e.g. "some-summary-issue"
}

const TICKET_RE = /([A-Z][A-Z0-9]+)-(\d+)/;

/**
 * Extract a Jira ticket key from raw input: a bare key ("LPB-1234"),
 * a Jira URL (".../browse/LPB-1234"), or free text containing one.
 */
export function extractTicketKey(input: string): TicketKey | undefined {
  if (!input) {
    return undefined;
  }
  const m = input.toUpperCase().match(TICKET_RE);
  if (!m) {
    return undefined;
  }
  return { project: m[1], number: m[2], key: `${m[1]}-${m[2]}` };
}

/**
 * Turn an arbitrary ticket title into a URL/branch-safe slug.
 * "Fix login button doesn't work!" -> "fix-login-button-doesnt-work"
 */
export function slugify(text: string, maxLen = 60): string {
  const slug = (text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")   // strip accents
    .toLowerCase()
    .replace(/['"]/g, "")               // drop apostrophes/quotes entirely
    .replace(/[^a-z0-9]+/g, "-")        // everything else -> hyphen
    .replace(/^-+|-+$/g, "")            // trim leading/trailing hyphens
    .replace(/-{2,}/g, "-");            // collapse runs

  if (slug.length <= maxLen) {
    return slug;
  }
  // Trim to maxLen without cutting a word in half where avoidable.
  const cut = slug.slice(0, maxLen);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
}

/**
 * Build a branch name: `feature/LPB-1234-some-summary-issue`.
 */
export function buildBranchName(prefix: string, ticketKey: string, title: string): string {
  const slug = slugify(title);
  const parts = [ticketKey, slug].filter(Boolean).join("-");
  return `${prefix}/${parts}`;
}

/**
 * Parse a branch built by buildBranchName back into its pieces.
 * Returns undefined if the branch doesn't match the convention.
 */
export function parseBranchName(branch: string): ParsedBranch | undefined {
  if (!branch) {
    return undefined;
  }
  const slashIdx = branch.indexOf("/");
  if (slashIdx <= 0) {
    return undefined;
  }
  const prefix = branch.slice(0, slashIdx);
  const rest = branch.slice(slashIdx + 1);
  const t = extractTicketKey(rest);
  if (!t) {
    return undefined;
  }
  // Everything after "TICKET-KEY-" is the slug.
  const afterKey = rest.slice(rest.toUpperCase().indexOf(t.key) + t.key.length);
  const slug = afterKey.replace(/^-+/, "");
  return { prefix, ticket: t.key, slug };
}

/**
 * Build a commit message: `feat: LPB-1234 some summary issue`.
 * `commitPrefix` is already mapped from the branch prefix by the caller.
 */
export function buildCommitMessage(commitPrefix: string, ticketKey: string, summary: string): string {
  const clean = (summary || "").trim().replace(/\s+/g, " ");
  return `${commitPrefix}: ${ticketKey} ${clean}`.trim();
}
