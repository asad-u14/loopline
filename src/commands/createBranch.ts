import * as vscode from "vscode";
import { GitService } from "../services/git";
import { JiraService, JiraIssueSummary } from "../services/jira";
import { readConfigForRepo, ensureConfigured, LooplineConfig } from "../util/config";
import { extractTicketKey, buildBranchName } from "../util/text";
import {
  resolveRepoRoot,
  buildJiraService,
  tryTransitionTicket,
} from "../util/workspace";
import { withCancellableProgress, isCancelled } from "../util/progress";
import { log, logError } from "../util/log";
import { showTicketDetail } from "../ui/ticketDetailPanel";
import { recordBranchCreated } from "../util/impactStore";

interface ChosenTicket {
  key: string;
  summary: string;
  issueType: string;
}

export async function createBranchCommand(
  ctx: vscode.ExtensionContext,
  preselectedKey?: string
): Promise<void> {
  if (!(await ensureConfigured(ctx))) {
    return;
  }

  const repoRoot = await resolveRepoRoot(ctx);
  if (!repoRoot) {
    return;
  }
  const git = new GitService(repoRoot);
  if (!(await git.isRepo())) {
    vscode.window.showErrorMessage("Loopline: this folder isn't a git repository.");
    return;
  }

  const cfg = readConfigForRepo(repoRoot);
  const jira = await buildJiraService(ctx);
  if (!jira) {
    vscode.window.showErrorMessage("Loopline: Jira isn't configured. Run the setup wizard.");
    return;
  }

  // 1. Pick a ticket — preselected (e.g. from the sidebar), or chosen now.
  const chosen = preselectedKey
    ? await fetchChosenByKey(jira, preselectedKey)
    : await chooseTicket(jira, cfg.jiraTicketScope === "activeSprint");
  if (!chosen) {
    return;
  }

  // 2. Build the branch name and (optionally) confirm/edit it.
  const prefix =
    cfg.branchTypeMapping[chosen.issueType] || cfg.branchTypeMapping["*"] || "feature";
  let branchName = buildBranchName(prefix, chosen.key, chosen.summary, cfg.branchNameTemplate);
  if (cfg.confirmBranchName) {
    const edited = await promptBranchName(branchName, chosen);
    if (edited === undefined) {
      return;
    }
    branchName = edited;
  }

  // 3. Resolve conflicts with any existing branch (exact or same-ticket).
  const outcome = await resolveExistingBranch(git, chosen.key, branchName);
  if (outcome.kind === "cancel") {
    return;
  }
  if (outcome.kind === "checkedOut") {
    await vscode.commands.executeCommand("loopline.refreshTicketStatus");
    return;
  }
  branchName = outcome.branchName;

  // 4. Warn about uncommitted changes that would follow onto the new branch.
  if (await git.hasUncommittedChanges()) {
    const go = await vscode.window.showWarningMessage(
      "You have uncommitted changes — they'll carry over onto the new branch. Continue?",
      "Continue",
      "Cancel"
    );
    if (go !== "Continue") {
      return;
    }
  }

  // 5. Optionally branch from a freshly-updated base.
  const baseChoice = await resolveBaseStartPoint(git, cfg);
  if (baseChoice.cancelled) {
    return;
  }

  // 6. Create + checkout (from the chosen start point, or current HEAD).
  try {
    if (baseChoice.startPoint) {
      await git.createAndCheckoutFrom(branchName, baseChoice.startPoint);
      vscode.window.showInformationMessage(
        `Loopline: created ${branchName} from ${baseChoice.startPoint}`
      );
    } else {
      await git.createAndCheckout(branchName);
      vscode.window.showInformationMessage(`Loopline: switched to ${branchName}`);
    }
    log(`created branch ${branchName}${baseChoice.startPoint ? ` from ${baseChoice.startPoint}` : ""}`);
    await recordBranchCreated(ctx);
  } catch (err) {
    logError("branch creation failed", err);
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
    return;
  }

  // 7. Optional ticket transition, then refresh the status bar.
  if (cfg.jiraTransitionOnBranch) {
    await tryTransitionTicket(ctx, chosen.key, cfg.jiraTransitionOnBranch);
  }
  await vscode.commands.executeCommand("loopline.refreshTicketStatus");

  // 8. Show ticket details, and offer AI implementation suggestions on request.
  if (cfg.showTicketDetailsOnBranch) {
    await showTicketDetailsAndOfferPlan(ctx, jira, chosen, repoRoot, cfg);
  }
}

// ---- base branch handling ---------------------------------------------------

interface BaseChoice {
  startPoint?: string; // undefined = branch from current HEAD
  cancelled?: boolean;
}

/**
 * Decide whether to branch from a freshly-updated base. Governed by
 * `loopline.updateBaseBeforeBranch` (ask | always | never). When updating, fetch
 * the base from origin and start the new branch at origin/<base>. Degrades
 * gracefully (offers to branch from HEAD) if the fetch or base ref fails.
 */
async function resolveBaseStartPoint(git: GitService, cfg: LooplineConfig): Promise<BaseChoice> {
  const base = cfg.baseBranch || cfg.defaultTargetBranch;
  if (!base || cfg.updateBaseBeforeBranch === "never") {
    return { startPoint: undefined };
  }

  let doUpdate: boolean;
  if (cfg.updateBaseBeforeBranch === "always") {
    doUpdate = true;
  } else {
    const pick = await vscode.window.showInformationMessage(
      `Update "${base}" from origin before creating the branch?`,
      "Update & branch",
      "Branch from current HEAD",
      "Cancel"
    );
    if (pick === undefined || pick === "Cancel") {
      return { cancelled: true };
    }
    doUpdate = pick === "Update & branch";
  }
  if (!doUpdate) {
    return { startPoint: undefined };
  }

  // Fetch the base from origin.
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loopline: fetching ${base}…`, cancellable: false },
      () => git.fetch("origin", base)
    );
  } catch (err) {
    logError("base fetch failed", err);
    const go = await vscode.window.showWarningMessage(
      `Couldn't fetch "${base}" (${(err as Error).message}). Branch from current HEAD instead?`,
      "Branch from HEAD",
      "Cancel"
    );
    return go === "Branch from HEAD" ? { startPoint: undefined } : { cancelled: true };
  }

  // Prefer the freshly-fetched remote ref, then the local base.
  if (await git.revExists(`origin/${base}`)) {
    return { startPoint: `origin/${base}` };
  }
  if (await git.revExists(base)) {
    return { startPoint: base };
  }
  const go = await vscode.window.showWarningMessage(
    `Base "${base}" not found after fetch. Branch from current HEAD?`,
    "Branch from HEAD",
    "Cancel"
  );
  return go === "Branch from HEAD" ? { startPoint: undefined } : { cancelled: true };
}

// ---- ticket details ---------------------------------------------------------

async function showTicketDetailsAndOfferPlan(
  ctx: vscode.ExtensionContext,
  jira: JiraService,
  chosen: ChosenTicket,
  _repoRoot: string,
  cfg: LooplineConfig
): Promise<void> {
  // Fetch the full ticket (for the description + status). Non-fatal.
  let summary = chosen.summary;
  let description = "";
  let status = "";
  try {
    const issue = await withCancellableProgress(`Loopline: loading ${chosen.key} details…`, (signal) =>
      jira.getIssue(chosen.key, signal)
    );
    summary = issue.summary || summary;
    description = issue.description || "";
    status = issue.status || "";
  } catch (err) {
    if (isCancelled(err)) {
      return;
    }
    // fall through with what we have
  }

  // Single, themed webview — the "Generate suggestions" button lives inside it.
  showTicketDetail(ctx, {
    key: chosen.key,
    summary,
    issueType: chosen.issueType,
    status,
    description,
    jiraBaseUrl: cfg.jiraBaseUrl,
  });
}

// ---- ticket selection -------------------------------------------------------

async function chooseTicket(
  jira: JiraService,
  activeSprintOnly: boolean
): Promise<ChosenTicket | undefined> {
  let issues: JiraIssueSummary[] = [];
  let sprintFilterApplied = true;
  try {
    const result = await withCancellableProgress(
      activeSprintOnly
        ? "Loopline: loading your active-sprint tickets…"
        : "Loopline: loading your open Jira tickets…",
      (signal) => jira.getMyOpenIssues(signal, activeSprintOnly)
    );
    issues = result.issues;
    sprintFilterApplied = result.sprintFilterApplied;
  } catch (err) {
    if (isCancelled(err)) {
      return undefined;
    }
    vscode.window.showWarningMessage(
      `Loopline: couldn't load assigned tickets (${(err as Error).message}). Enter a key manually.`
    );
    return manualTicket(jira);
  }

  interface Item extends vscode.QuickPickItem {
    issue?: JiraIssueSummary;
  }
  const items: Item[] = issues.map((i) => ({
    label: `${i.key}  ${i.summary}`,
    description: [i.issueType, i.status].filter(Boolean).join(" • "),
    issue: i,
  }));
  items.push({ label: "$(edit) Enter a ticket key manually…" });

  const scopeLabel =
    activeSprintOnly && sprintFilterApplied ? "active sprint" : "assigned & open";
  const pick = await vscode.window.showQuickPick(items, {
    title: "Loopline: pick a ticket to branch from",
    placeHolder: issues.length
      ? `Your ${scopeLabel} tickets`
      : `No tickets in your ${scopeLabel} — enter a key manually`,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!pick) {
    return undefined;
  }
  if (!pick.issue) {
    return manualTicket(jira);
  }
  return { key: pick.issue.key, summary: pick.issue.summary, issueType: pick.issue.issueType };
}

async function manualTicket(jira: JiraService): Promise<ChosenTicket | undefined> {
  const raw = await vscode.window.showInputBox({
    title: "Loopline: Create Branch",
    prompt: "Enter a Jira ticket key or URL (e.g. LPB-1234).",
    ignoreFocusOut: true,
    validateInput: (v) =>
      extractTicketKey(v) ? undefined : "Couldn't find a ticket key like ABC-123.",
  });
  if (!raw) {
    return undefined;
  }
  return fetchChosenByKey(jira, extractTicketKey(raw)!.key);
}

/** Fetch a ticket's summary/type by key, for preselected or manually-entered keys. */
async function fetchChosenByKey(jira: JiraService, key: string): Promise<ChosenTicket | undefined> {
  try {
    const issue = await withCancellableProgress(`Fetching ${key}…`, (signal) =>
      jira.getIssue(key, signal)
    );
    return { key: issue.key, summary: issue.summary, issueType: issue.issueType };
  } catch (err) {
    if (isCancelled(err)) {
      return undefined;
    }
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
    return undefined;
  }
}

// ---- existing-branch handling ----------------------------------------------

type BranchOutcome =
  | { kind: "create"; branchName: string }
  | { kind: "checkedOut" }
  | { kind: "cancel" };

async function resolveExistingBranch(
  git: GitService,
  ticketKey: string,
  initialName: string
): Promise<BranchOutcome> {
  let branchName = initialName;

  while (true) {
    const exact = await git.branchExists(branchName);
    const others = (await git.branchesForTicket(ticketKey)).filter((b) => b !== branchName);

    if (exact) {
      const pick = await vscode.window.showWarningMessage(
        `Branch "${branchName}" already exists.`,
        "Check it out",
        "Choose a different name",
        "Cancel"
      );
      if (pick === "Check it out") {
        return (await checkoutExisting(git, branchName)) ? { kind: "checkedOut" } : { kind: "cancel" };
      }
      if (pick === "Choose a different name") {
        const next = await promptBranchName(branchName);
        if (next === undefined) {
          return { kind: "cancel" };
        }
        branchName = next;
        continue;
      }
      return { kind: "cancel" };
    }

    if (others.length > 0) {
      const label =
        others.length === 1
          ? `A branch for ${ticketKey} already exists: "${others[0]}".`
          : `${others.length} branches already exist for ${ticketKey}.`;
      const pick = await vscode.window.showWarningMessage(
        label,
        "Check out existing",
        "Create new anyway",
        "Cancel"
      );
      if (pick === "Check out existing") {
        const target =
          others.length === 1
            ? others[0]
            : await vscode.window.showQuickPick(others, {
                title: `Existing branches for ${ticketKey}`,
                ignoreFocusOut: true,
              });
        if (!target) {
          continue; // sub-pick dismissed — return to the choice
        }
        return (await checkoutExisting(git, target)) ? { kind: "checkedOut" } : { kind: "cancel" };
      }
      if (pick === "Create new anyway") {
        return { kind: "create", branchName };
      }
      return { kind: "cancel" };
    }

    return { kind: "create", branchName };
  }
}

async function checkoutExisting(git: GitService, name: string): Promise<boolean> {
  try {
    await git.checkout(name);
    vscode.window.showInformationMessage(`Loopline: switched to existing ${name}.`);
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
    return false;
  }
}

async function promptBranchName(
  current: string,
  chosen?: ChosenTicket
): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "Loopline: branch name",
    prompt: chosen ? `${chosen.issueType || "ticket"} • ${chosen.summary}` : "Enter a branch name",
    value: current,
    ignoreFocusOut: true,
    validateInput: (v) => (v.includes("/") ? undefined : "Expected a prefix/, e.g. feature/…"),
  });
  return value === undefined ? undefined : value.trim();
}
