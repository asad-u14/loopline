import * as vscode from "vscode";
import { GitService } from "../services/git";
import { parseBranchName } from "../util/text";
import { currentRepoQuiet } from "../util/workspace";

export interface TicketContext {
  repoRoot: string;
  branch: string;
  ticket?: string;
}

/**
 * A status-bar item that shows the Jira ticket for the current branch and, on
 * click, opens an action menu (Open Jira / Open MR / commit / create branch).
 * Refreshes on editor/focus changes and on `.git/HEAD` changes (external checkouts).
 */
export class TicketStatusBar {
  private item: vscode.StatusBarItem;
  private headWatcher?: vscode.FileSystemWatcher;
  private watchedRepo?: string;
  private state?: TicketContext;

  constructor(private ctx: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "loopline.ticketActions";
    ctx.subscriptions.push(
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
    );
  }

  getState(): TicketContext | undefined {
    return this.state;
  }

  async refresh(): Promise<void> {
    const repoRoot = await currentRepoQuiet(this.ctx);
    if (!repoRoot) {
      this.state = undefined;
      this.item.hide();
      return;
    }
    this.ensureHeadWatcher(repoRoot);

    let branch = "";
    try {
      branch = await new GitService(repoRoot).currentBranch();
    } catch {
      /* ignore */
    }
    const ticket = branch ? parseBranchName(branch)?.ticket : undefined;
    this.state = { repoRoot, branch, ticket };

    if (ticket) {
      this.item.text = `$(git-branch) ${ticket}`;
      this.item.tooltip = `Loopline • ${ticket} on "${branch}"\nClick for actions (Open Jira, Open MR…)`;
    } else {
      this.item.text = "$(git-branch) Loopline";
      this.item.tooltip = branch
        ? `Loopline • "${branch}" (no ticket in branch name)\nClick for actions`
        : "Loopline • no branch\nClick for actions";
    }
    this.item.show();
  }

  private ensureHeadWatcher(repoRoot: string): void {
    if (this.watchedRepo === repoRoot) {
      return;
    }
    this.headWatcher?.dispose();
    this.watchedRepo = repoRoot;
    // Watching .git/HEAD catches external `git checkout`.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoRoot, ".git/HEAD")
    );
    const onChange = () => this.refresh();
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    this.headWatcher = watcher;
    this.ctx.subscriptions.push(watcher);
  }

  dispose(): void {
    this.headWatcher?.dispose();
    this.item.dispose();
  }
}
