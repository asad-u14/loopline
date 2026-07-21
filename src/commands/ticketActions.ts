import * as vscode from "vscode";
import { GitService } from "../services/git";
import { readConfig } from "../util/config";
import {
  buildGitLabService,
  resolveGitLabProject,
  resolveRepoRoot,
} from "../util/workspace";
import { withCancellableProgress, isCancelled } from "../util/progress";
import { TicketStatusBar, TicketContext } from "../ui/statusBar";
import { openTicketDetailsCommand } from "./ticketDetails";

interface ActionItem extends vscode.QuickPickItem {
  action: "jira" | "detail" | "mr" | "copy" | "create" | "commit";
}

export async function ticketActionsCommand(
  ctx: vscode.ExtensionContext,
  statusBar: TicketStatusBar
): Promise<void> {
  await statusBar.refresh();
  const state = statusBar.getState();
  const cfg = readConfig();

  const items: ActionItem[] = [];
  if (state?.ticket) {
    items.push({ label: "$(book) Open ticket in VS Code", description: state.ticket, action: "detail" });
  }
  if (state?.ticket && cfg.jiraBaseUrl) {
    items.push({ label: "$(link-external) Open Jira ticket", description: state.ticket, action: "jira" });
  }
  if (state?.ticket) {
    items.push({ label: "$(git-pull-request) Open merge request", description: "find the MR for this branch", action: "mr" });
    items.push({ label: "$(copy) Copy ticket key", description: state.ticket, action: "copy" });
  }
  items.push({ label: "$(git-branch) Create branch from Jira ticket", action: "create" });
  items.push({ label: "$(cloud-upload) Commit, Push & Create MR", action: "commit" });

  const pick = await vscode.window.showQuickPick(items, {
    title: state?.ticket ? `Loopline • ${state.ticket}` : "Loopline",
    placeHolder: state?.branch ? `On "${state.branch}"` : "No branch detected",
  });
  if (!pick) {
    return;
  }

  switch (pick.action) {
    case "jira":
      vscode.env.openExternal(vscode.Uri.parse(`${cfg.jiraBaseUrl}/browse/${state!.ticket}`));
      break;
    case "detail":
      await openTicketDetailsCommand(ctx, { key: state!.ticket! });
      break;
    case "copy":
      await vscode.env.clipboard.writeText(state!.ticket!);
      vscode.window.showInformationMessage(`Loopline: copied ${state!.ticket}.`);
      break;
    case "create":
      await vscode.commands.executeCommand("loopline.createBranch");
      break;
    case "commit":
      await vscode.commands.executeCommand("loopline.commitAndPush");
      break;
    case "mr":
      await openMrForBranch(ctx, state!);
      break;
  }
}


async function openMrForBranch(ctx: vscode.ExtensionContext, state: TicketContext): Promise<void> {
  const gitlab = await buildGitLabService(ctx);
  if (!gitlab) {
    vscode.window.showErrorMessage("Loopline: GitLab isn't configured. Run the setup wizard.");
    return;
  }
  const project = await resolveGitLabProject(new GitService(state.repoRoot));
  if (!project) {
    vscode.window.showErrorMessage(
      "Loopline: couldn't determine the GitLab project. Set `loopline.gitlab.projectId`."
    );
    return;
  }
  try {
    const mr = await withCancellableProgress("Loopline: looking for the MR…", (signal) =>
      gitlab.findOpenMR(project, state.branch, signal)
    );
    if (mr) {
      vscode.env.openExternal(vscode.Uri.parse(mr.web_url));
      return;
    }
    const go = await vscode.window.showInformationMessage(
      "Loopline: no open MR for this branch yet.",
      "Create one"
    );
    if (go === "Create one") {
      await vscode.commands.executeCommand("loopline.commitAndPush");
    }
  } catch (err) {
    if (isCancelled(err)) {
      return;
    }
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
  }
}

/**
 * Switch to the local branch for a ticket. If several branches reference the
 * ticket, ask which. Falls back to the create-branch flow when none exist.
 */
export async function checkoutTicketBranchCommand(
  ctx: vscode.ExtensionContext,
  ticketKey: string | undefined
): Promise<void> {
  if (!ticketKey) {
    return;
  }
  const repoRoot = await resolveRepoRoot(ctx);
  if (!repoRoot) {
    return;
  }
  const git = new GitService(repoRoot);

  const branches = await git.branchesForTicket(ticketKey);
  if (branches.length === 0) {
    // Nothing to switch to — do the useful thing instead.
    await vscode.commands.executeCommand("loopline.tickets.createBranch", ticketKey);
    return;
  }

  const current = await git.currentBranch();
  if (branches.length === 1 && branches[0] === current) {
    vscode.window.showInformationMessage(`Loopline: already on ${current}.`);
    return;
  }

  const target =
    branches.length === 1
      ? branches[0]
      : await vscode.window.showQuickPick(
          branches.map((b) => ({ label: b, description: b === current ? "current" : undefined })),
          { title: `Loopline: branches for ${ticketKey}`, ignoreFocusOut: true }
        ).then((p) => p?.label);
  if (!target) {
    return;
  }
  if (target === current) {
    vscode.window.showInformationMessage(`Loopline: already on ${current}.`);
    return;
  }

  try {
    await git.checkout(target);
    vscode.window.showInformationMessage(`Loopline: switched to ${target}`);
    await vscode.commands.executeCommand("loopline.refreshTicketStatus");
  } catch (err) {
    // Most often: uncommitted changes would be overwritten.
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
  }
}

/**
 * Quick-switch from the "Current" section's inline button back to main/master.
 * The button only renders when the tree is clean, but state can change between
 * render and click, so re-check here rather than trusting the tree item.
 */
export async function switchToMainBranchCommand(ctx: vscode.ExtensionContext): Promise<void> {
  const repoRoot = await resolveRepoRoot(ctx);
  if (!repoRoot) {
    return;
  }
  const git = new GitService(repoRoot);
  const current = await git.currentBranch();
  const branches = await git.listLocalBranches();
  const target = branches.includes("main") ? "main" : branches.includes("master") ? "master" : undefined;
  if (!target || target === current) {
    return;
  }
  if (await git.hasUncommittedChanges()) {
    vscode.window.showWarningMessage("Loopline: commit or stash your changes before switching branches.");
    return;
  }
  try {
    await git.checkout(target);
    vscode.window.showInformationMessage(`Loopline: switched to ${target}`);
    await vscode.commands.executeCommand("loopline.refreshTicketStatus");
  } catch (err) {
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
  }
}
