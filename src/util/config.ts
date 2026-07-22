import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { logError } from "./log";
import { DEFAULT_BRANCH_TEMPLATE, DEFAULT_COMMIT_TEMPLATE } from "./text";
import { ProjectConfig, PROJECT_CONFIG_FILENAME, filterProjectConfig } from "./projectConfig";
import { DEFAULT_CHANGELOG_CATEGORY_MAPPING } from "./changelog";

export type JiraType = "cloud" | "server";
export type AiProvider = "anthropic" | "openai";

export interface LooplineConfig {
  jiraType: JiraType;
  jiraBaseUrl: string;
  jiraEmail: string;
  gitlabHost: string;
  gitlabProjectId: string;
  defaultTargetBranch: string;
  branchTypeMapping: Record<string, string>;
  commitTypeMapping: Record<string, string>;
  confirmBranchName: boolean;
  includeJiraDescription: boolean;
  protectedBranches: string[];
  jiraTransitionOnBranch: string;
  jiraTransitionOnMr: string;
  jiraTicketScope: "activeSprint" | "allOpen";
  aiEnabled: boolean;
  aiProvider: AiProvider;
  aiModel: string;
  aiBaseUrl: string;
  aiMaxDiffBytes: number;
  aiCheckDiffAgainstTicket: boolean;
  showTicketDetailsOnBranch: boolean;
  baseBranch: string;
  updateBaseBeforeBranch: "ask" | "always" | "never";
  groupTicketsByStatus: boolean;
  colorfulTicketIcons: boolean;
  impactMinutesPerBranch: number;
  impactMinutesPerCommit: number;
  impactMinutesPerMr: number;
  staging: "respectStaged" | "pick" | "all";
  singleCommit: "squash" | "off";
  httpProxy: string;
  httpExtraCaCerts: string[];
  httpAllowInsecureTls: boolean;
  branchNameTemplate: string;
  commitMessageTemplate: string;
  changelogEnabled: boolean;
  changelogCategoryMapping: Record<string, string>;
  gitCommitExtraArgs: string[];
  gitPushExtraArgs: string[];
}

const SECRET_JIRA_TOKEN = "loopline.jira.token";
const SECRET_GITLAB_TOKEN = "loopline.gitlab.token";
const SECRET_ANTHROPIC_KEY = "loopline.anthropic.apiKey";
const SECRET_OPENAI_KEY = "loopline.openai.apiKey";

export function readConfig(): LooplineConfig {
  const c = vscode.workspace.getConfiguration("loopline");
  const aiProvider = (c.get<string>("ai.provider") as AiProvider) || "anthropic";
  return {
    jiraType: (c.get<string>("jira.type") as JiraType) || "cloud",
    jiraBaseUrl: (c.get<string>("jira.baseUrl") || "").replace(/\/+$/, ""),
    jiraEmail: c.get<string>("jira.email") || "",
    gitlabHost: (c.get<string>("gitlab.host") || "https://gitlab.com").replace(/\/+$/, ""),
    gitlabProjectId: c.get<string>("gitlab.projectId") || "",
    defaultTargetBranch: c.get<string>("defaultTargetBranch") || "main",
    branchTypeMapping: c.get<Record<string, string>>("branchTypeMapping") || {},
    commitTypeMapping: c.get<Record<string, string>>("commitTypeMapping") || {},
    confirmBranchName: c.get<boolean>("confirmBranchName") ?? true,
    includeJiraDescription: c.get<boolean>("mr.includeJiraDescription") ?? true,
    protectedBranches: c.get<string[]>("protectedBranches") ?? ["main", "master", "develop"],
    jiraTransitionOnBranch: (c.get<string>("jira.transitionOnBranch") || "").trim(),
    jiraTransitionOnMr: (c.get<string>("jira.transitionOnMr") || "").trim(),
    jiraTicketScope:
      (c.get<string>("jira.ticketScope") as "activeSprint" | "allOpen") || "activeSprint",
    aiEnabled: c.get<boolean>("ai.enabled") ?? false,
    aiProvider,
    aiModel: (c.get<string>("ai.model") || (aiProvider === "openai" ? "" : "claude-sonnet-5")).trim(),
    aiBaseUrl: (c.get<string>("ai.baseUrl") || (aiProvider === "openai" ? "" : "https://api.anthropic.com"))
      .trim()
      .replace(/\/+$/, ""),
    aiMaxDiffBytes: c.get<number>("ai.maxDiffBytes") ?? 60000,
    aiCheckDiffAgainstTicket: c.get<boolean>("ai.checkDiffAgainstTicket") ?? false,
    showTicketDetailsOnBranch: c.get<boolean>("showTicketDetailsOnBranch") ?? true,
    baseBranch: (c.get<string>("baseBranch") || "").trim(),
    updateBaseBeforeBranch:
      (c.get<string>("updateBaseBeforeBranch") as "ask" | "always" | "never") || "ask",
    groupTicketsByStatus: c.get<boolean>("sidebar.groupByStatus") ?? true,
    colorfulTicketIcons: c.get<boolean>("sidebar.colorfulIcons") ?? true,
    impactMinutesPerBranch: c.get<number>("impact.minutesPerBranch") ?? 15,
    impactMinutesPerCommit: c.get<number>("impact.minutesPerCommit") ?? 5,
    impactMinutesPerMr: c.get<number>("impact.minutesPerMr") ?? 10,
    staging:
      (c.get<string>("staging") as "respectStaged" | "pick" | "all") || "respectStaged",
    singleCommit: (c.get<string>("singleCommit") as "squash" | "off") || "squash",
    httpProxy: (c.get<string>("http.proxy") || "").trim(),
    httpExtraCaCerts: c.get<string[]>("http.extraCaCerts") ?? [],
    httpAllowInsecureTls: c.get<boolean>("http.allowInsecureTls") ?? false,
    branchNameTemplate: c.get<string>("branchNameTemplate") || DEFAULT_BRANCH_TEMPLATE,
    commitMessageTemplate: c.get<string>("commitMessageTemplate") || DEFAULT_COMMIT_TEMPLATE,
    changelogEnabled: c.get<boolean>("changelog.enabled") ?? false,
    changelogCategoryMapping:
      c.get<Record<string, string>>("changelog.categoryMapping") || DEFAULT_CHANGELOG_CATEGORY_MAPPING,
    gitCommitExtraArgs: c.get<string[]>("git.commitExtraArgs") ?? [],
    gitPushExtraArgs: c.get<string[]>("git.pushExtraArgs") ?? [],
  };
}

let warnedInvalidProjectConfig = false;

/**
 * Read a project's committed `.loopline.json`, if present. Read-only: this never
 * creates or writes the file — its mere absence means nothing changes. Invalid
 * JSON is warned about once and otherwise ignored, rather than breaking the
 * extension over a typo.
 */
export function loadProjectConfig(repoRoot: string): ProjectConfig | undefined {
  const filePath = path.join(repoRoot, PROJECT_CONFIG_FILENAME);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return filterProjectConfig(parsed);
  } catch (err) {
    if (!warnedInvalidProjectConfig) {
      warnedInvalidProjectConfig = true;
      vscode.window.showWarningMessage(
        `Loopline: ${PROJECT_CONFIG_FILENAME} is invalid JSON — ignoring it (${(err as Error).message}).`
      );
    }
    return undefined;
  }
}

/** True if the developer (or the workspace) explicitly set this setting themselves. */
function isExplicitlySet(c: vscode.WorkspaceConfiguration, key: string): boolean {
  const i = c.inspect(key);
  return i?.globalValue !== undefined || i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined;
}

/**
 * Same as readConfig(), but fills gaps from the repo's `.loopline.json` (if any)
 * for keys the developer hasn't explicitly set themselves. An explicit personal
 * or workspace setting always wins over the team file — it only fills in for
 * whoever hasn't customized something, never silently overrides a deliberate
 * local choice.
 */
export function readConfigForRepo(repoRoot: string | undefined): LooplineConfig {
  const cfg = readConfig();
  if (!repoRoot) {
    return cfg;
  }
  const project = loadProjectConfig(repoRoot);
  if (!project) {
    return cfg;
  }

  const c = vscode.workspace.getConfiguration("loopline");
  const merged = { ...cfg };
  if (project.branchTypeMapping && !isExplicitlySet(c, "branchTypeMapping")) {
    merged.branchTypeMapping = project.branchTypeMapping;
  }
  if (project.commitTypeMapping && !isExplicitlySet(c, "commitTypeMapping")) {
    merged.commitTypeMapping = project.commitTypeMapping;
  }
  if (project.protectedBranches && !isExplicitlySet(c, "protectedBranches")) {
    merged.protectedBranches = project.protectedBranches;
  }
  if (project.defaultTargetBranch !== undefined && !isExplicitlySet(c, "defaultTargetBranch")) {
    merged.defaultTargetBranch = project.defaultTargetBranch;
  }
  if (project.jiraTransitionOnBranch !== undefined && !isExplicitlySet(c, "jira.transitionOnBranch")) {
    merged.jiraTransitionOnBranch = project.jiraTransitionOnBranch;
  }
  if (project.jiraTransitionOnMr !== undefined && !isExplicitlySet(c, "jira.transitionOnMr")) {
    merged.jiraTransitionOnMr = project.jiraTransitionOnMr;
  }
  if (project.jiraTicketScope && !isExplicitlySet(c, "jira.ticketScope")) {
    merged.jiraTicketScope = project.jiraTicketScope;
  }
  if (project.staging && !isExplicitlySet(c, "staging")) {
    merged.staging = project.staging;
  }
  if (project.singleCommit && !isExplicitlySet(c, "singleCommit")) {
    merged.singleCommit = project.singleCommit;
  }
  if (project.branchNameTemplate !== undefined && !isExplicitlySet(c, "branchNameTemplate")) {
    merged.branchNameTemplate = project.branchNameTemplate;
  }
  if (project.commitMessageTemplate !== undefined && !isExplicitlySet(c, "commitMessageTemplate")) {
    merged.commitMessageTemplate = project.commitMessageTemplate;
  }
  if (project.changelogEnabled !== undefined && !isExplicitlySet(c, "changelog.enabled")) {
    merged.changelogEnabled = project.changelogEnabled;
  }
  if (project.changelogCategoryMapping && !isExplicitlySet(c, "changelog.categoryMapping")) {
    merged.changelogCategoryMapping = project.changelogCategoryMapping;
  }
  return merged;
}

/** Networking options shared by every outbound service call. */
export function httpOptionsFromConfig(): {
  proxy?: string;
  extraCaCerts?: string[];
  allowInsecureTls?: boolean;
} {
  const cfg = readConfig();
  return {
    proxy: cfg.httpProxy || undefined,
    extraCaCerts: cfg.httpExtraCaCerts,
    allowInsecureTls: cfg.httpAllowInsecureTls,
  };
}

/**
 * Validate user-editable settings that could be broken by hand-editing settings.json.
 * Returns a list of human-readable problems (empty = all good).
 */
export function validateConfig(): string[] {
  const c = vscode.workspace.getConfiguration("loopline");
  const problems: string[] = [];

  const isStringMap = (v: unknown): boolean =>
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");

  const branchMap = c.get("branchTypeMapping");
  if (branchMap !== undefined && !isStringMap(branchMap)) {
    problems.push("`loopline.branchTypeMapping` must be an object of string → string.");
  }
  const commitMap = c.get("commitTypeMapping");
  if (commitMap !== undefined && !isStringMap(commitMap)) {
    problems.push("`loopline.commitTypeMapping` must be an object of string → string.");
  }

  const type = c.get<string>("jira.type");
  if (type && type !== "cloud" && type !== "server") {
    problems.push("`loopline.jira.type` must be either \"cloud\" or \"server\".");
  }

  const baseUrl = c.get<string>("jira.baseUrl");
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    problems.push("`loopline.jira.baseUrl` must start with http:// or https://.");
  }

  const host = c.get<string>("gitlab.host");
  if (host && !/^https?:\/\//.test(host)) {
    problems.push("`loopline.gitlab.host` must start with http:// or https://.");
  }

  const protectedBranches = c.get("protectedBranches");
  if (
    protectedBranches !== undefined &&
    (!Array.isArray(protectedBranches) || !protectedBranches.every((x) => typeof x === "string"))
  ) {
    problems.push("`loopline.protectedBranches` must be an array of strings.");
  }

  const proxy = c.get<string>("http.proxy");
  if (proxy && !/^https?:\/\/.+/i.test(proxy.trim())) {
    problems.push("`loopline.http.proxy` must be a URL like http://proxy.corp.com:8080.");
  }

  const cas = c.get("http.extraCaCerts");
  if (cas !== undefined && (!Array.isArray(cas) || !cas.every((x) => typeof x === "string"))) {
    problems.push("`loopline.http.extraCaCerts` must be an array of file paths.");
  }

  return problems;
}

let configWriteWarned = false;

/**
 * Write a global setting. Never throws: if VS Code rejects the write (most often
 * "not a registered configuration" after an in-place extension update against a
 * stale manifest), we warn once with a reload hint and continue, so setup can
 * finish and secrets (stored separately) aren't lost. Returns whether it saved.
 */
export async function updateSetting(key: string, value: unknown): Promise<boolean> {
  try {
    await vscode.workspace
      .getConfiguration("loopline")
      .update(key, value, vscode.ConfigurationTarget.Global);
    return true;
  } catch (err) {
    if (!configWriteWarned) {
      configWriteWarned = true;
      vscode.window.showWarningMessage(
        `Loopline couldn't save "loopline.${key}". If you just updated the extension, reload the window ` +
          `(Command Palette → "Developer: Reload Window"), then re-run setup. Any tokens you entered were still saved.`
      );
    }
    console.warn(`Loopline: failed to write setting loopline.${key}:`, err);
    logError(`failed to write setting loopline.${key}`, err);
    return false;
  }
}

/** Allow a fresh wizard run to warn again if writes are still failing. */
export function resetConfigWriteWarning(): void {
  configWriteWarned = false;
}

export function getJiraToken(ctx: vscode.ExtensionContext): Thenable<string | undefined> {
  return ctx.secrets.get(SECRET_JIRA_TOKEN);
}
export function setJiraToken(ctx: vscode.ExtensionContext, token: string): Thenable<void> {
  return ctx.secrets.store(SECRET_JIRA_TOKEN, token);
}
export function getGitLabToken(ctx: vscode.ExtensionContext): Thenable<string | undefined> {
  return ctx.secrets.get(SECRET_GITLAB_TOKEN);
}
export function setGitLabToken(ctx: vscode.ExtensionContext, token: string): Thenable<void> {
  return ctx.secrets.store(SECRET_GITLAB_TOKEN, token);
}
export function getAnthropicKey(ctx: vscode.ExtensionContext): Thenable<string | undefined> {
  return ctx.secrets.get(SECRET_ANTHROPIC_KEY);
}
export function setAnthropicKey(ctx: vscode.ExtensionContext, key: string): Thenable<void> {
  return ctx.secrets.store(SECRET_ANTHROPIC_KEY, key);
}
export function getOpenAiKey(ctx: vscode.ExtensionContext): Thenable<string | undefined> {
  return ctx.secrets.get(SECRET_OPENAI_KEY);
}
export function setOpenAiKey(ctx: vscode.ExtensionContext, key: string): Thenable<void> {
  return ctx.secrets.store(SECRET_OPENAI_KEY, key);
}

export interface MissingItem {
  what: string;
}

/**
 * Return a human-readable list of everything still missing for the extension
 * to work. Empty array means fully configured.
 */
export async function findMissingConfig(
  ctx: vscode.ExtensionContext
): Promise<string[]> {
  const cfg = readConfig();
  const missing: string[] = [];

  if (!cfg.jiraBaseUrl) {
    missing.push("Jira base URL");
  }
  if (cfg.jiraType === "cloud" && !cfg.jiraEmail) {
    missing.push("Jira email (required for Cloud)");
  }
  if (!(await getJiraToken(ctx))) {
    missing.push("Jira token");
  }
  if (!(await getGitLabToken(ctx))) {
    missing.push("GitLab token");
  }
  return missing;
}

/**
 * Gate for commands. If anything is missing, tell the user exactly what and
 * offer to launch the setup wizard. Returns true only when good to proceed.
 */
export async function ensureConfigured(
  ctx: vscode.ExtensionContext
): Promise<boolean> {
  const missing = await findMissingConfig(ctx);
  if (missing.length === 0) {
    return true;
  }
  const pick = await vscode.window.showWarningMessage(
    `Loopline isn't fully set up yet — missing: ${missing.join(", ")}.`,
    "Run Setup Wizard",
    "Cancel"
  );
  if (pick === "Run Setup Wizard") {
    await vscode.commands.executeCommand("loopline.runSetup");
  }
  return false;
}
