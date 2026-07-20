import * as vscode from "vscode";
import * as path from "path";
import { GitService } from "../services/git";
import { discoverRepos, buildAiService } from "../util/workspace";
import { withCancellableProgress, isCancelled } from "../util/progress";
import { logError } from "../util/log";
import { groupCommitsByTicket, formatStandupFallbackByRepo, startOfDay, RepoCommitGroup } from "../util/standup";
import { showStandupSummary } from "../ui/standupPanel";

export async function standupSummaryCommand(ctx: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("Loopline: open a folder or workspace first.");
    return;
  }

  let repoRoots: string[] = [];
  let repoGroups: RepoCommitGroup[] = [];
  try {
    repoGroups = await withCancellableProgress(
      "Loopline: reading today's commits across every repo…",
      async () => {
        repoRoots = await discoverRepos(folders.map((f) => f.uri.fsPath));
        const results = await Promise.all(
          repoRoots.map(async (root) => {
            const subjects = await new GitService(root).listMyCommitsSince(startOfDay().toISOString());
            return { repoName: path.basename(root) || root, groups: groupCommitsByTicket(subjects) };
          })
        );
        return results.filter((r) => r.groups.length > 0);
      }
    );
  } catch (err) {
    if (isCancelled(err)) {
      return;
    }
    logError("standup: reading commits failed", err);
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
    return;
  }

  if (repoRoots.length === 0) {
    vscode.window.showErrorMessage("Loopline: no git repository found in this workspace.");
    return;
  }

  if (repoGroups.length === 0) {
    vscode.window.showInformationMessage("Loopline: no commits found for today yet.");
    return;
  }

  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const anthropic = await buildAiService(ctx);
  let markdown = formatStandupFallbackByRepo(repoGroups);
  let aiGenerated = false;
  if (anthropic) {
    try {
      markdown = await withCancellableProgress("Loopline: drafting standup summary…", (signal) =>
        anthropic.generateStandupSummary({ repos: repoGroups, dateLabel }, signal)
      );
      aiGenerated = true;
    } catch (err) {
      if (!isCancelled(err)) {
        vscode.window.showWarningMessage(
          `Loopline: AI summary failed (${(err as Error).message}). Using the plain list instead.`
        );
      }
    }
  }

  showStandupSummary({ dateLabel, markdown, aiGenerated });
}
