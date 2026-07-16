import * as vscode from "vscode";
import { readConfig } from "../util/config";
import { buildJiraService } from "../util/workspace";
import { withCancellableProgress, isCancelled } from "../util/progress";
import { showTicketDetail } from "../ui/ticketDetailPanel";
import { logError } from "../util/log";

/** Minimal shape the sidebar already knows about, used as a fallback. */
export interface KnownTicket {
  key: string;
  summary?: string;
  issueType?: string;
  status?: string;
}

/**
 * Open a ticket's details inside VS Code (the shared Loopline panel), without
 * needing a browser. Reuses the same panel as the post-branch-creation view, so
 * opening another ticket updates it rather than stacking tabs.
 */
export async function openTicketDetailsCommand(
  ctx: vscode.ExtensionContext,
  ticket: KnownTicket | undefined
): Promise<void> {
  if (!ticket?.key) {
    return;
  }
  const cfg = readConfig();

  const jira = await buildJiraService(ctx);
  if (!jira) {
    vscode.window.showErrorMessage("Loopline: Jira isn't configured. Run the setup wizard.");
    return;
  }

  // Start from what the sidebar already has, so we can still show something
  // useful if the fetch fails.
  let summary = ticket.summary ?? "";
  let issueType = ticket.issueType ?? "";
  let status = ticket.status ?? "";
  let description = "";

  try {
    const issue = await withCancellableProgress(`Loopline: loading ${ticket.key}…`, (signal) =>
      jira.getIssue(ticket.key, signal)
    );
    summary = issue.summary || summary;
    issueType = issue.issueType || issueType;
    status = issue.status || status;
    description = issue.description || "";
  } catch (err) {
    if (isCancelled(err)) {
      return;
    }
    logError(`could not load ${ticket.key} details`, err);
    vscode.window.showWarningMessage(
      `Loopline: couldn't load the full ticket (${(err as Error).message}). Showing what's known.`
    );
  }

  showTicketDetail(ctx, {
    key: ticket.key,
    summary,
    issueType,
    status,
    description,
    jiraBaseUrl: cfg.jiraBaseUrl,
  });
}
