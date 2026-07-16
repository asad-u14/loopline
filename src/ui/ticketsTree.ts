import * as vscode from "vscode";
import { JiraIssueSummary } from "../services/jira";
import { GitService } from "../services/git";
import { parseBranchName } from "../util/text";
import { readConfig, findMissingConfig } from "../util/config";
import { buildJiraService, currentRepoQuiet } from "../util/workspace";
import { logError } from "../util/log";
import {
  iconForType,
  colorForType,
  keyFromArg,
  scopeSectionLabel,
  TicketScope,
  mapTicketBranches,
  relativeTime,
  notablePriority,
  groupIssuesByStatus,
  shouldGroupByStatus,
  statusCategoryRank,
} from "../util/tree-helpers";

export { keyFromArg };

type Node =
  | { t: "section"; id: "current" | "sprint"; label: string }
  | { t: "current"; ticket?: string; branch: string }
  | { t: "statusGroup"; status: string; category?: string; issues: JiraIssueSummary[] }
  | { t: "ticket"; issue: JiraIssueSummary; grouped: boolean }
  | { t: "message"; label: string; icon?: string; command?: vscode.Command };

export class TicketsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private issues: JiraIssueSummary[] | undefined;
  private loadError: string | undefined;
  /** Scope the cached issues were fetched for; a scope change invalidates them. */
  private loadedScope: TicketScope | undefined;
  /** False when an active-sprint request fell back to all-open (no sprints on the board). */
  private sprintFilterApplied = true;
  /** ticket key -> local branches referencing it. */
  private ticketBranches: Record<string, string[]> = {};

  constructor(private ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.touch()),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          this.touch();
        }
      })
    );
  }

  /** Full refresh — re-fetch tickets. */
  refresh(): void {
    this.issues = undefined;
    this.loadError = undefined;
    this.loadedScope = undefined;
    this.sprintFilterApplied = true;
    this.ticketBranches = {};
    this._onDidChange.fire();
  }

  private get scope(): TicketScope {
    return readConfig().jiraTicketScope;
  }

  /** Light refresh — re-render (e.g. branch changed) without re-fetching tickets. */
  touch(): void {
    this._onDidChange.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.t) {
      case "section": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = `section:${node.id}`;
        return item;
      }
      case "current": {
        if (node.ticket) {
          const item = new vscode.TreeItem(node.ticket, vscode.TreeItemCollapsibleState.None);
          item.description = node.branch;
          item.tooltip = `On "${node.branch}" — click for ticket actions`;
          item.iconPath = new vscode.ThemeIcon("git-branch");
          item.contextValue = "currentTicket";
          item.command = { command: "loopline.ticketActions", title: "Ticket actions" };
          return item;
        }
        const item = new vscode.TreeItem(
          node.branch ? `On "${node.branch}"` : "No branch",
          vscode.TreeItemCollapsibleState.None
        );
        item.description = "no ticket";
        item.iconPath = new vscode.ThemeIcon("git-branch");
        return item;
      }
      case "statusGroup": {
        // Only the "In Progress" category starts expanded; the rest stay out of the way.
        const collapsible =
          statusCategoryRank(node.category) === 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(node.status, collapsible);
        item.description = `${node.issues.length}`;
        item.contextValue = "statusGroup";
        return item;
      }
      case "ticket": {
        const i = node.issue;
        const branches = this.ticketBranches[i.key] ?? [];
        const hasBranch = branches.length > 0;

        const item = new vscode.TreeItem(`${i.key}  ${i.summary}`, vscode.TreeItemCollapsibleState.None);

        // Status is redundant when it's already the group header.
        item.description = [
          i.issueType,
          node.grouped ? undefined : i.status,
          notablePriority(i.priority),
          relativeTime(i.updated),
          hasBranch ? "on branch" : undefined,
        ]
          .filter(Boolean)
          .join(" • ");

        const tip = [
          `${i.key}: ${i.summary}`,
          [i.issueType, i.status, i.priority ? `${i.priority} priority` : undefined]
            .filter(Boolean)
            .join(" • "),
        ];
        const age = relativeTime(i.updated);
        if (age) {
          tip.push(`Updated ${age} ago`);
        }
        if (hasBranch) {
          tip.push("", `Branch${branches.length > 1 ? "es" : ""}: ${branches.join(", ")}`);
          tip.push("Click to switch to it");
        } else {
          tip.push("", "Click to create a branch");
        }
        item.tooltip = tip.join("\n");

        item.iconPath = readConfig().colorfulTicketIcons
          ? new vscode.ThemeIcon(iconForType(i.issueType), new vscode.ThemeColor(colorForType(i.issueType)))
          : new vscode.ThemeIcon(iconForType(i.issueType));
        // Drives which inline actions appear.
        item.contextValue = hasBranch ? "ticketWithBranch" : "ticket";
        item.command = hasBranch
          ? {
              command: "loopline.tickets.checkout",
              title: "Switch to branch",
              arguments: [node],
            }
          : {
              command: "loopline.tickets.createBranch",
              title: "Create branch from ticket",
              arguments: [node],
            };
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        if (node.icon) {
          item.iconPath = new vscode.ThemeIcon(node.icon);
        }
        if (node.command) {
          item.command = node.command;
        }
        return item;
      }
    }
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      // Empty array here lets the viewsWelcome (Run Setup) content show.
      const missing = await findMissingConfig(this.ctx);
      if (missing.length > 0) {
        return [];
      }
      return [
        { t: "section", id: "current", label: "Current" },
        {
          t: "section",
          id: "sprint",
          label: scopeSectionLabel(this.scope, this.sprintFilterApplied),
        },
      ];
    }

    if (element.t === "section" && element.id === "current") {
      const repoRoot = await currentRepoQuiet(this.ctx);
      if (!repoRoot) {
        return [{ t: "message", label: "No git repository open", icon: "info" }];
      }
      let branch = "";
      try {
        branch = await new GitService(repoRoot).currentBranch();
      } catch {
        /* ignore */
      }
      const ticket = branch ? parseBranchName(branch)?.ticket : undefined;
      return [{ t: "current", ticket, branch }];
    }

    if (element.t === "section" && element.id === "sprint") {
      return this.getSprintChildren();
    }
    if (element.t === "statusGroup") {
      return element.issues.map((issue) => ({ t: "ticket" as const, issue, grouped: true }));
    }
    return [];
  }

  private async getSprintChildren(): Promise<Node[]> {
    const scope = this.scope;

    // A scope change invalidates the cache.
    if (this.loadedScope !== undefined && this.loadedScope !== scope) {
      this.issues = undefined;
      this.loadError = undefined;
      this.loadedScope = undefined;
    }

    if (this.issues) {
      return this.renderIssues(this.issues, scope);
    }
    if (this.loadError) {
      return this.renderError(this.loadError);
    }

    const jira = await buildJiraService(this.ctx);
    if (!jira) {
      return [
        {
          t: "message",
          label: "Connect Jira to see tickets",
          icon: "gear",
          command: { command: "loopline.runSetup", title: "Run Setup" },
        },
      ];
    }
    try {
      const result = await jira.getMyOpenIssues(undefined, scope === "activeSprint");
      this.issues = result.issues;
      this.sprintFilterApplied = result.sprintFilterApplied;
      this.loadedScope = scope;
      await this.loadTicketBranches(this.issues.map((i) => i.key));
      // The section label depends on what we actually got, so re-render it.
      if (scope === "activeSprint" && !result.sprintFilterApplied) {
        queueMicrotask(() => this._onDidChange.fire());
      }
      return this.renderIssues(this.issues, scope);
    } catch (err) {
      logError("tickets tree load failed", err);
      this.loadError = `Couldn't load tickets: ${(err as Error).message}`;
      this.loadedScope = scope;
      return this.renderError(this.loadError);
    }
  }

  private renderIssues(issues: JiraIssueSummary[], scope: TicketScope): Node[] {
    if (issues.length) {
      if (readConfig().groupTicketsByStatus && shouldGroupByStatus(issues)) {
        return groupIssuesByStatus(issues).map((g) => ({
          t: "statusGroup" as const,
          status: g.status,
          category: g.category,
          issues: g.issues,
        }));
      }
      return issues.map((issue) => ({ t: "ticket" as const, issue, grouped: false }));
    }
    // Empty states are actionable rather than dead ends.
    if (scope === "activeSprint") {
      return [
        { t: "message", label: "No tickets in your active sprint", icon: "check" },
        {
          t: "message",
          label: "Show all open tickets…",
          icon: "list-unordered",
          command: { command: "loopline.tickets.showAllOpen", title: "Show all open tickets" },
        },
      ];
    }
    return [{ t: "message", label: "No open tickets assigned to you", icon: "check" }];
  }

  /**
   * Which tickets already have a local branch. One `git branch` call for the whole
   * list rather than one per ticket. Non-fatal: no repo just means no markers.
   */
  private async loadTicketBranches(keys: string[]): Promise<void> {
    this.ticketBranches = {};
    try {
      const repoRoot = await currentRepoQuiet(this.ctx);
      if (!repoRoot) {
        return;
      }
      const branches = await new GitService(repoRoot).listLocalBranches();
      this.ticketBranches = mapTicketBranches(branches, keys);
    } catch (err) {
      logError("could not read local branches for ticket markers", err);
    }
  }

  private renderError(message: string): Node[] {
    return [
      { t: "message", label: message, icon: "warning" },
      {
        t: "message",
        label: "Retry",
        icon: "refresh",
        command: { command: "loopline.tickets.refresh", title: "Retry" },
      },
      {
        t: "message",
        label: "Diagnose connection…",
        icon: "debug-alt",
        command: { command: "loopline.diagnose", title: "Diagnose connection" },
      },
    ];
  }

}
