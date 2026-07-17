/**
 * Pure validation for a project's committed `.loopline.json` — no vscode or fs
 * import, so trivially unit-testable. File reading lives in config.ts, which
 * already depends on vscode for the "invalid JSON" warning.
 */

export const PROJECT_CONFIG_FILENAME = ".loopline.json";

/** Only the team-shareable conventions — never secrets, tokens, or personal/UI prefs. */
export interface ProjectConfig {
  branchTypeMapping?: Record<string, string>;
  commitTypeMapping?: Record<string, string>;
  protectedBranches?: string[];
  defaultTargetBranch?: string;
  jiraTransitionOnBranch?: string;
  jiraTransitionOnMr?: string;
  jiraTicketScope?: "activeSprint" | "allOpen";
  staging?: "respectStaged" | "pick" | "all";
  singleCommit?: "squash" | "off";
  branchNameTemplate?: string;
  commitMessageTemplate?: string;
  changelogEnabled?: boolean;
  changelogCategoryMapping?: Record<string, string>;
}

/** Every key a `.loopline.json` may set — used both to validate and to scaffold one. */
export const PROJECT_CONFIG_KEYS: (keyof ProjectConfig)[] = [
  "branchTypeMapping",
  "commitTypeMapping",
  "protectedBranches",
  "defaultTargetBranch",
  "jiraTransitionOnBranch",
  "jiraTransitionOnMr",
  "jiraTicketScope",
  "staging",
  "singleCommit",
  "branchNameTemplate",
  "commitMessageTemplate",
  "changelogEnabled",
  "changelogCategoryMapping",
];

/**
 * Keep only recognized, correctly-typed keys from an arbitrary parsed JSON value.
 * Anything unrecognized or malformed is silently dropped rather than throwing —
 * a typo'd key shouldn't break the whole file.
 */
export function filterProjectConfig(raw: unknown): ProjectConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const r = raw as Record<string, unknown>;
  const out: ProjectConfig = {};

  if (isStringRecord(r.branchTypeMapping)) {
    out.branchTypeMapping = r.branchTypeMapping;
  }
  if (isStringRecord(r.commitTypeMapping)) {
    out.commitTypeMapping = r.commitTypeMapping;
  }
  if (isStringArray(r.protectedBranches)) {
    out.protectedBranches = r.protectedBranches;
  }
  if (typeof r.defaultTargetBranch === "string") {
    out.defaultTargetBranch = r.defaultTargetBranch;
  }
  if (typeof r.jiraTransitionOnBranch === "string") {
    out.jiraTransitionOnBranch = r.jiraTransitionOnBranch;
  }
  if (typeof r.jiraTransitionOnMr === "string") {
    out.jiraTransitionOnMr = r.jiraTransitionOnMr;
  }
  if (r.jiraTicketScope === "activeSprint" || r.jiraTicketScope === "allOpen") {
    out.jiraTicketScope = r.jiraTicketScope;
  }
  if (r.staging === "respectStaged" || r.staging === "pick" || r.staging === "all") {
    out.staging = r.staging;
  }
  if (r.singleCommit === "squash" || r.singleCommit === "off") {
    out.singleCommit = r.singleCommit;
  }
  if (typeof r.branchNameTemplate === "string") {
    out.branchNameTemplate = r.branchNameTemplate;
  }
  if (typeof r.commitMessageTemplate === "string") {
    out.commitMessageTemplate = r.commitMessageTemplate;
  }
  if (typeof r.changelogEnabled === "boolean") {
    out.changelogEnabled = r.changelogEnabled;
  }
  if (isStringRecord(r.changelogCategoryMapping)) {
    out.changelogCategoryMapping = r.changelogCategoryMapping;
  }
  return out;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === "string")
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
