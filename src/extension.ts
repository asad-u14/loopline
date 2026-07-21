import * as vscode from "vscode";
import { runSetupWizard } from "./setup/wizard";
import { createBranchCommand } from "./commands/createBranch";
import { commitAndPushCommand } from "./commands/commitAndPush";
import {
  ticketActionsCommand,
  checkoutTicketBranchCommand,
  switchToMainBranchCommand,
} from "./commands/ticketActions";
import { diagnoseConnectionCommand } from "./commands/diagnose";
import { TicketStatusBar } from "./ui/statusBar";
import { TicketsTreeProvider, keyFromArg } from "./ui/ticketsTree";
import { openTicketDetailsCommand } from "./commands/ticketDetails";
import { showImpactDetailsCommand } from "./commands/impactDetails";
import { standupSummaryCommand } from "./commands/standupSummary";
import { createProjectConfigCommand } from "./commands/createProjectConfig";
import { ticketFromArg } from "./util/tree-helpers";
import { initLog, log, logError, showLog } from "./util/log";
import { resetHttpPlanLog } from "./util/http-client";
import {
  findMissingConfig,
  setJiraToken,
  setGitLabToken,
  setAnthropicKey,
  setOpenAiKey,
  validateConfig,
  readConfig,
  updateSetting,
} from "./util/config";

const FIRST_RUN_KEY = "loopline.hasOnboarded";

export function activate(context: vscode.ExtensionContext) {
  initLog(context);
  log("Loopline activated");

  // Status-bar ticket indicator (also confirms the extension is active, which is
  // useful even when a "Do Not Disturb" setting suppresses notifications).
  const statusBar = new TicketStatusBar(context);
  void statusBar.refresh();

  // Sidebar tickets view.
  const tickets = new TicketsTreeProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("loopline.ticketsView", tickets)
  );

  const register = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await fn();
        } catch (err) {
          // Never fail silently.
          logError(`command ${id} failed`, err);
          vscode.window.showErrorMessage(
            `Loopline (${id}) failed: ${(err as Error)?.message ?? String(err)}`
          );
        }
      })
    );

  register("loopline.showLogs", async () => showLog());
  register("loopline.diagnose", () => diagnoseConnectionCommand(context));

  register("loopline.runSetup", () => runSetupWizard(context).then(() => undefined));
  register("loopline.createBranch", () => createBranchCommand(context));
  register("loopline.commitAndPush", () => commitAndPushCommand(context));
  register("loopline.ticketActions", () => ticketActionsCommand(context, statusBar));
  register("loopline.refreshTicketStatus", async () => {
    await statusBar.refresh();
    tickets.touch();
  });
  register("loopline.showImpactDetails", () => showImpactDetailsCommand(context));
  register("loopline.standupSummary", () => standupSummaryCommand(context));
  register("loopline.createProjectConfig", () => createProjectConfigCommand(context));

  register("loopline.tickets.refresh", async () => tickets.refresh());

  // Scope toggle (title-bar button). The setting is the single source of truth,
  // so the sidebar and the Create Branch picker always agree.
  const syncScopeContext = () =>
    vscode.commands.executeCommand(
      "setContext",
      "loopline:ticketScope",
      readConfig().jiraTicketScope
    );
  void syncScopeContext();

  const setScope = async (scope: "activeSprint" | "allOpen") => {
    const saved = await updateSetting("jira.ticketScope", scope);
    await syncScopeContext();
    tickets.refresh();
    if (!saved) {
      // updateSetting already warned; make the no-op explicit rather than
      // leaving the view silently unchanged.
      logError(`could not persist ticket scope "${scope}"`);
    }
  };

  register("loopline.tickets.showAllOpen", () => setScope("allOpen"));
  register("loopline.tickets.showActiveSprint", () => setScope("activeSprint"));

  context.subscriptions.push(
    vscode.commands.registerCommand("loopline.tickets.createBranch", async (arg) => {
      try {
        await createBranchCommand(context, keyFromArg(arg));
      } catch (err) {
        logError("tickets.createBranch failed", err);
        vscode.window.showErrorMessage(`Loopline: ${(err as Error)?.message ?? String(err)}`);
      }
    }),
    vscode.commands.registerCommand("loopline.tickets.checkout", async (arg) => {
      try {
        await checkoutTicketBranchCommand(context, keyFromArg(arg));
      } catch (err) {
        logError("tickets.checkout failed", err);
        vscode.window.showErrorMessage(`Loopline: ${(err as Error)?.message ?? String(err)}`);
      }
    }),
    vscode.commands.registerCommand("loopline.tickets.openDetails", async (arg) => {
      try {
        await openTicketDetailsCommand(context, ticketFromArg(arg));
      } catch (err) {
        logError("tickets.openDetails failed", err);
        vscode.window.showErrorMessage(`Loopline: ${(err as Error)?.message ?? String(err)}`);
      }
    }),
    vscode.commands.registerCommand("loopline.tickets.switchToMain", async () => {
      try {
        await switchToMainBranchCommand(context);
      } catch (err) {
        logError("tickets.switchToMain failed", err);
        vscode.window.showErrorMessage(`Loopline: ${(err as Error)?.message ?? String(err)}`);
      }
    }),
    vscode.commands.registerCommand("loopline.tickets.openInJira", async (arg) => {
      const key = keyFromArg(arg);
      const cfg = readConfig();
      if (key && cfg.jiraBaseUrl) {
        vscode.env.openExternal(vscode.Uri.parse(`${cfg.jiraBaseUrl}/browse/${key}`));
      } else if (key) {
        vscode.window.showWarningMessage("Loopline: set your Jira base URL to open tickets in the browser.");
      }
    })
  );

  register("loopline.setJiraCredentials", async () => {
    const token = await vscode.window.showInputBox({
      title: "Loopline: Set Jira Token",
      prompt: "Paste your Jira API token / PAT.",
      password: true,
      ignoreFocusOut: true,
    });
    if (token && token.trim()) {
      await setJiraToken(context, token.trim());
      vscode.window.showInformationMessage("Loopline: Jira token saved.");
    }
  });

  register("loopline.setGitLabToken", async () => {
    const token = await vscode.window.showInputBox({
      title: "Loopline: Set GitLab Token",
      prompt: "Paste your GitLab Personal Access Token (scope: api).",
      password: true,
      ignoreFocusOut: true,
    });
    if (token && token.trim()) {
      await setGitLabToken(context, token.trim());
      vscode.window.showInformationMessage("Loopline: GitLab token saved.");
    }
  });

  register("loopline.setAnthropicKey", async () => {
    const key = await vscode.window.showInputBox({
      title: "Loopline: Set AI (Anthropic) API Key",
      prompt: "Paste your Anthropic API key (console.anthropic.com → API Keys).",
      password: true,
      ignoreFocusOut: true,
    });
    if (key && key.trim()) {
      await setAnthropicKey(context, key.trim());
      vscode.window.showInformationMessage("Loopline: Anthropic API key saved. Enable AI in settings if needed.");
    }
  });

  register("loopline.setOpenAiKey", async () => {
    const key = await vscode.window.showInputBox({
      title: "Loopline: Set AI (OpenAI Gateway) API Key",
      prompt: "Paste the API key for your OpenAI-compatible AI gateway.",
      password: true,
      ignoreFocusOut: true,
    });
    if (key && key.trim()) {
      await setOpenAiKey(context, key.trim());
      vscode.window.showInformationMessage(
        "Loopline: AI gateway API key saved. Set loopline.ai.provider to \"openai\" and enable AI in settings if needed."
      );
    }
  });

  // Validate settings now, and whenever the user edits them.
  const runValidation = () => {
    const problems = validateConfig();
    if (problems.length > 0) {
      vscode.window.showWarningMessage(
        `Loopline: check your settings — ${problems[0]}` +
          (problems.length > 1 ? ` (+${problems.length - 1} more)` : "")
      );
    }
  };
  runValidation();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("loopline")) {
        runValidation();
      }
      if (e.affectsConfiguration("loopline.http")) {
        resetHttpPlanLog();
        log("network settings changed — proxy/CA configuration reloaded");
      }
      if (e.affectsConfiguration("loopline.jira.ticketScope")) {
        void syncScopeContext();
        tickets.refresh();
      }
    })
  );

  // First-run onboarding prompt.
  void maybeOfferFirstRunSetup(context);
}

async function maybeOfferFirstRunSetup(context: vscode.ExtensionContext) {
  const onboarded = context.globalState.get<boolean>(FIRST_RUN_KEY, false);
  const missing = await findMissingConfig(context);

  if (onboarded && missing.length === 0) {
    return;
  }

  const pick = await vscode.window.showInformationMessage(
    "Loopline is installed. Set up Jira + GitLab now?",
    "Run Setup",
    "Later"
  );
  if (pick === "Run Setup") {
    const done = await runSetupWizard(context);
    if (done) {
      await context.globalState.update(FIRST_RUN_KEY, true);
    }
  } else {
    // Don't nag on every restart, but do re-offer if still unconfigured later.
    await context.globalState.update(FIRST_RUN_KEY, true);
  }
}

export function deactivate() {
  /* nothing to clean up */
}
