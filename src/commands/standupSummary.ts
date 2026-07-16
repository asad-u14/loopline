import * as vscode from "vscode";
import { GitService } from "../services/git";
import { resolveRepoRoot, buildAnthropicService } from "../util/workspace";
import { withCancellableProgress, isCancelled } from "../util/progress";
import { logError } from "../util/log";
import { groupCommitsByTicket, formatStandupFallback, startOfDay } from "../util/standup";

export async function standupSummaryCommand(ctx: vscode.ExtensionContext): Promise<void> {
  const repoRoot = await resolveRepoRoot(ctx);
  if (!repoRoot) {
    return;
  }
  const git = new GitService(repoRoot);
  if (!(await git.isRepo())) {
    vscode.window.showErrorMessage("Loopline: this folder isn't a git repository.");
    return;
  }

  let subjects: string[] = [];
  try {
    subjects = await withCancellableProgress("Loopline: reading today's commits…", () =>
      git.listMyCommitsSince(startOfDay().toISOString())
    );
  } catch (err) {
    if (isCancelled(err)) {
      return;
    }
    logError("standup: reading commits failed", err);
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
    return;
  }

  if (subjects.length === 0) {
    vscode.window.showInformationMessage("Loopline: no commits found for today yet.");
    return;
  }

  const groups = groupCommitsByTicket(subjects);
  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const fallback = formatStandupFallback(groups, dateLabel);

  const anthropic = await buildAnthropicService(ctx);
  let text = fallback;
  if (anthropic) {
    try {
      text = await withCancellableProgress("Loopline: drafting standup summary…", (signal) =>
        anthropic.generateStandupSummary({ groups, dateLabel }, signal)
      );
    } catch (err) {
      if (!isCancelled(err)) {
        vscode.window.showWarningMessage(
          `Loopline: AI summary failed (${(err as Error).message}). Using the plain list instead.`
        );
      }
    }
  }

  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: text });
  await vscode.window.showTextDocument(doc, { preview: true });
}
