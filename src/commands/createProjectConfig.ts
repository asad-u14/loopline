import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { readConfig } from "../util/config";
import { ProjectConfig, PROJECT_CONFIG_FILENAME } from "../util/projectConfig";
import { resolveRepoRoot } from "../util/workspace";
import { logError } from "../util/log";

/**
 * Scaffold a `.loopline.json` at the repo root, pre-filled with every
 * team-shareable field from the current effective settings, so a team lead
 * gets a complete, ready-to-edit starting point rather than an empty shell.
 * Never runs on its own — only when this command is explicitly invoked.
 */
export async function createProjectConfigCommand(ctx: vscode.ExtensionContext): Promise<void> {
  const repoRoot = await resolveRepoRoot(ctx);
  if (!repoRoot) {
    return;
  }

  const filePath = path.join(repoRoot, PROJECT_CONFIG_FILENAME);
  if (fs.existsSync(filePath)) {
    const choice = await vscode.window.showInformationMessage(
      `Loopline: ${PROJECT_CONFIG_FILENAME} already exists.`,
      "Open it"
    );
    if (choice === "Open it") {
      await openFile(filePath);
    }
    return;
  }

  const cfg = readConfig();
  const starter: Required<ProjectConfig> = {
    branchTypeMapping: cfg.branchTypeMapping,
    commitTypeMapping: cfg.commitTypeMapping,
    protectedBranches: cfg.protectedBranches,
    defaultTargetBranch: cfg.defaultTargetBranch,
    jiraTransitionOnBranch: cfg.jiraTransitionOnBranch,
    jiraTransitionOnMr: cfg.jiraTransitionOnMr,
    jiraTicketScope: cfg.jiraTicketScope,
    staging: cfg.staging,
    singleCommit: cfg.singleCommit,
    branchNameTemplate: cfg.branchNameTemplate,
    commitMessageTemplate: cfg.commitMessageTemplate,
  };

  try {
    fs.writeFileSync(filePath, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
  } catch (err) {
    logError("createProjectConfig: write failed", err);
    vscode.window.showErrorMessage(`Loopline: couldn't write ${PROJECT_CONFIG_FILENAME}: ${(err as Error).message}`);
    return;
  }

  await openFile(filePath);
  vscode.window.showInformationMessage(
    `Loopline: created ${PROJECT_CONFIG_FILENAME} from your current settings — edit it, then commit it so your team shares these conventions. ` +
      "Anyone with their own explicit setting keeps it; this only fills in for teammates who haven't customized that setting."
  );
}

async function openFile(filePath: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc, { preview: false });
}
