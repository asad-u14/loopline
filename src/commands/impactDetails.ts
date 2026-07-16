import * as vscode from "vscode";
import { readConfig } from "../util/config";
import { formatImpactDetail } from "../util/impact";
import { getImpactStats, resetImpactStats } from "../util/impactStore";

export async function showImpactDetailsCommand(ctx: vscode.ExtensionContext): Promise<void> {
  const cfg = readConfig();
  const stats = getImpactStats(ctx);
  const rates = {
    minutesPerBranch: cfg.impactMinutesPerBranch,
    minutesPerCommit: cfg.impactMinutesPerCommit,
    minutesPerMr: cfg.impactMinutesPerMr,
  };

  const choice = await vscode.window.showInformationMessage(
    "Loopline Impact",
    { modal: true, detail: formatImpactDetail(stats, rates) },
    "Reset counters"
  );
  if (choice !== "Reset counters") {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    "Reset your Loopline impact counters? This can't be undone.",
    "Reset",
    "Cancel"
  );
  if (confirm === "Reset") {
    await resetImpactStats(ctx);
    await vscode.commands.executeCommand("loopline.refreshTicketStatus");
  }
}
