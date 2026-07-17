import * as vscode from "vscode";
import {
  readConfig,
  updateSetting,
  getJiraToken,
  setJiraToken,
  getGitLabToken,
  setGitLabToken,
  JiraType,
  AiProvider,
  getAnthropicKey,
  setAnthropicKey,
  getOpenAiKey,
  setOpenAiKey,
  resetConfigWriteWarning,
  httpOptionsFromConfig,
} from "../util/config";
import { JiraService } from "../services/jira";
import { GitLabService } from "../services/gitlab";
import { AnthropicService } from "../services/anthropic";
import { OpenAiGatewayService } from "../services/openaiGateway";

/** Run an async check under a progress toast; return null on success, else the error message. */
async function testConnection(title: string, fn: () => Promise<string>): Promise<string | null> {
  try {
    const who = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      fn
    );
    vscode.window.showInformationMessage(`Loopline: connected as ${who}.`);
    return null;
  } catch (err) {
    return (err as Error)?.message ?? String(err);
  }
}

/**
 * Guided setup. Safe to re-run any time — every prompt pre-fills the current
 * value so the user can review or rotate a single thing without re-typing all.
 * Returns true if the wizard completed, false if cancelled.
 */
export async function runSetupWizard(ctx: vscode.ExtensionContext): Promise<boolean> {
  resetConfigWriteWarning();
  const cfg = readConfig();

  // Step 1 — Jira type
  const typePick = await vscode.window.showQuickPick(
    [
      { label: "Jira Cloud", detail: "*.atlassian.net — email + API token", value: "cloud" },
      { label: "Jira Server / Data Center", detail: "self-hosted — Personal Access Token", value: "server" },
    ],
    {
      title: "Loopline Setup (1/8): Jira type",
      placeHolder: cfg.jiraType === "cloud" ? "Current: Cloud" : "Current: Server/DC",
      ignoreFocusOut: true,
    }
  );
  if (!typePick) {
    return false;
  }
  const jiraType = typePick.value as JiraType;
  await updateSetting("jira.type", jiraType);

  // Step 2 — Jira base URL
  const baseUrl = await vscode.window.showInputBox({
    title: "Loopline Setup (2/8): Jira base URL",
    prompt: "e.g. https://your-company.atlassian.net or https://jira.your-company.com",
    value: cfg.jiraBaseUrl,
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^https?:\/\/.+/.test(v.trim()) ? undefined : "Must start with http:// or https://",
  });
  if (baseUrl === undefined) {
    return false;
  }
  await updateSetting("jira.baseUrl", baseUrl.trim());

  // Step 3 — Jira email (Cloud only)
  if (jiraType === "cloud") {
    const email = await vscode.window.showInputBox({
      title: "Loopline Setup (3/8): Jira account email",
      prompt: "Your Atlassian login email (used for Basic auth).",
      value: cfg.jiraEmail,
      ignoreFocusOut: true,
      validateInput: (v) => (v.includes("@") ? undefined : "That doesn't look like an email."),
    });
    if (email === undefined) {
      return false;
    }
    await updateSetting("jira.email", email.trim());
  } else {
    await updateSetting("jira.email", "");
  }

  // Step 4 — Jira token
  const existingJira = await getJiraToken(ctx);
  const jiraTokenPrompt =
    jiraType === "cloud"
      ? "Jira API token (create at id.atlassian.com/manage-profile/security/api-tokens)"
      : "Jira Personal Access Token (Profile → Personal Access Tokens)";
  const jiraToken = await vscode.window.showInputBox({
    title: "Loopline Setup (4/8): Jira token",
    prompt: existingJira ? `${jiraTokenPrompt} — leave blank to keep the existing one` : jiraTokenPrompt,
    password: true,
    ignoreFocusOut: true,
  });
  if (jiraToken === undefined) {
    return false;
  }
  // Effective token to validate: newly entered, or the existing one if left blank.
  const jiraTokenToUse = jiraToken.trim() || existingJira || "";

  // Validate before saving/advancing.
  const jiraError = await testConnection("Verifying Jira credentials…", () =>
    new JiraService({
      type: jiraType,
      baseUrl: baseUrl.trim(),
      email: jiraType === "cloud" ? (readConfig().jiraEmail) : "",
      token: jiraTokenToUse,
      http: httpOptionsFromConfig(),
    }).verify()
  );
  if (jiraError) {
    const choice = await vscode.window.showErrorMessage(
      `Jira check failed: ${jiraError}`,
      "Re-enter token",
      "Save anyway",
      "Cancel"
    );
    if (choice === "Cancel" || choice === undefined) {
      return false;
    }
    if (choice === "Re-enter token") {
      return runSetupWizard(ctx); // restart so URL/email/token can all be fixed
    }
    // "Save anyway" falls through.
  }
  if (jiraToken.trim()) {
    await setJiraToken(ctx, jiraToken.trim());
  }

  // Step 5 — GitLab host
  const gitlabHost = await vscode.window.showInputBox({
    title: "Loopline Setup (5/8): GitLab host",
    prompt: "Usually https://gitlab.com",
    value: cfg.gitlabHost || "https://gitlab.com",
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^https?:\/\/.+/.test(v.trim()) ? undefined : "Must start with http:// or https://",
  });
  if (gitlabHost === undefined) {
    return false;
  }
  await updateSetting("gitlab.host", gitlabHost.trim());

  // Step 6 — GitLab token
  const existingGitLab = await getGitLabToken(ctx);
  const gitlabToken = await vscode.window.showInputBox({
    title: "Loopline Setup (6/8): GitLab token",
    prompt: existingGitLab
      ? "GitLab Personal Access Token (scope: api) — leave blank to keep the existing one"
      : "GitLab Personal Access Token (Settings → Access Tokens, scope: api)",
    password: true,
    ignoreFocusOut: true,
  });
  if (gitlabToken === undefined) {
    return false;
  }
  const gitlabTokenToUse = gitlabToken.trim() || existingGitLab || "";

  const gitlabError = await testConnection("Verifying GitLab token…", () =>
    new GitLabService(gitlabHost.trim(), gitlabTokenToUse, undefined, httpOptionsFromConfig()).verify()
  );
  if (gitlabError) {
    const choice = await vscode.window.showErrorMessage(
      `GitLab check failed: ${gitlabError}`,
      "Re-enter token",
      "Save anyway",
      "Cancel"
    );
    if (choice === "Cancel" || choice === undefined) {
      return false;
    }
    if (choice === "Re-enter token") {
      return runSetupWizard(ctx);
    }
    // "Save anyway" falls through.
  }
  if (gitlabToken.trim()) {
    await setGitLabToken(ctx, gitlabToken.trim());
  }

  // Step 7 — default target branch
  const target = await vscode.window.showInputBox({
    title: "Loopline Setup (7/8): Default MR target branch",
    prompt: "Branch merge requests target by default.",
    value: cfg.defaultTargetBranch || "main",
    ignoreFocusOut: true,
  });
  if (target === undefined) {
    return false;
  }
  await updateSetting("defaultTargetBranch", target.trim() || "main");

  // Step 8 — optional AI MR descriptions.
  const aiPick = await vscode.window.showQuickPick(
    [
      { label: "Enable AI MR descriptions", detail: "Sends your diff + ticket to an AI model to draft MR bodies", value: "on" },
      { label: "Not now", detail: "You can enable it later in settings", value: "off" },
    ],
    {
      title: "Loopline Setup (8/8): AI merge-request descriptions (optional)",
      placeHolder: cfg.aiEnabled ? "Currently: enabled" : "Currently: disabled",
      ignoreFocusOut: true,
    }
  );
  if (aiPick === undefined) {
    return false;
  }
  if (aiPick.value === "on") {
    await updateSetting("ai.enabled", true);

    const providerPick = await vscode.window.showQuickPick(
      [
        { label: "Anthropic", detail: "Direct to api.anthropic.com (or a proxy in front of it)", value: "anthropic" as AiProvider },
        { label: "OpenAI-compatible gateway", detail: "An internal gateway exposing the OpenAI chat completions API (e.g. in front of Bedrock)", value: "openai" as AiProvider },
      ],
      {
        title: "Loopline Setup (8/8): AI provider",
        placeHolder: `Currently: ${cfg.aiProvider === "openai" ? "OpenAI-compatible gateway" : "Anthropic"}`,
        ignoreFocusOut: true,
      }
    );
    if (providerPick === undefined) {
      return false;
    }
    await updateSetting("ai.provider", providerPick.value);

    if (providerPick.value === "openai") {
      const aborted = await setUpOpenAiGateway(ctx);
      if (aborted === "restart") {
        return runSetupWizard(ctx);
      }
      if (aborted === "cancel") {
        return false;
      }
    } else {
      const aborted = await setUpAnthropic(ctx);
      if (aborted === "restart") {
        return runSetupWizard(ctx);
      }
      if (aborted === "cancel") {
        return false;
      }
    }
  } else {
    await updateSetting("ai.enabled", false);
  }

  vscode.window.showInformationMessage("Loopline is set up. You're ready to go 🎉");
  return true;
}

/** Outcome of an in-wizard sub-step: undefined means "continue", otherwise restart or bail out entirely. */
type SubStepOutcome = "restart" | "cancel" | undefined;

async function setUpAnthropic(ctx: vscode.ExtensionContext): Promise<SubStepOutcome> {
  const existingKey = await getAnthropicKey(ctx);
  const key = await vscode.window.showInputBox({
    title: "Loopline Setup (8/8): Anthropic API key",
    prompt: existingKey
      ? "Anthropic API key (from console.anthropic.com) — leave blank to keep the existing one"
      : "Anthropic API key (create at console.anthropic.com → API Keys)",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return "cancel";
  }
  const keyToUse = key.trim() || existingKey || "";
  const aiError = await testConnection("Verifying Anthropic API key…", () =>
    new AnthropicService({
      apiKey: keyToUse,
      baseUrl: readConfig().aiBaseUrl,
      model: readConfig().aiModel,
      maxDiffBytes: readConfig().aiMaxDiffBytes,
      http: httpOptionsFromConfig(),
    })
      .verify()
      .then(() => "AI ready")
  );
  if (aiError) {
    const choice = await vscode.window.showErrorMessage(
      `Anthropic check failed: ${aiError}`,
      "Re-enter key",
      "Save anyway",
      "Skip AI"
    );
    if (choice === "Re-enter key") {
      return "restart";
    }
    if (choice === "Skip AI") {
      await updateSetting("ai.enabled", false);
    }
    // "Save anyway" falls through to store the key below.
  }
  if (key.trim()) {
    await setAnthropicKey(ctx, key.trim());
  }
  return undefined;
}

async function setUpOpenAiGateway(ctx: vscode.ExtensionContext): Promise<SubStepOutcome> {
  const cfg = readConfig();

  const baseUrl = await vscode.window.showInputBox({
    title: "Loopline Setup (8/8): AI gateway base URL",
    prompt: "The OpenAI-compatible base URL for your gateway (e.g. https://api-eu1.aigateway.example.com/v1)",
    value: cfg.aiBaseUrl,
    ignoreFocusOut: true,
  });
  if (baseUrl === undefined) {
    return "cancel";
  }
  if (!baseUrl.trim()) {
    vscode.window.showErrorMessage("Loopline: a gateway base URL is required for the OpenAI-compatible provider.");
    return "restart";
  }
  await updateSetting("ai.baseUrl", baseUrl.trim().replace(/\/+$/, ""));

  const model = await vscode.window.showInputBox({
    title: "Loopline Setup (8/8): AI gateway model id",
    prompt: "The model id your gateway expects (e.g. bedrock-claude-sonnet-4-5)",
    value: cfg.aiModel,
    ignoreFocusOut: true,
  });
  if (model === undefined) {
    return "cancel";
  }
  if (!model.trim()) {
    vscode.window.showErrorMessage("Loopline: a model id is required for the OpenAI-compatible provider.");
    return "restart";
  }
  await updateSetting("ai.model", model.trim());

  const existingKey = await getOpenAiKey(ctx);
  const key = await vscode.window.showInputBox({
    title: "Loopline Setup (8/8): AI gateway API key",
    prompt: existingKey
      ? "AI gateway API key — leave blank to keep the existing one"
      : "AI gateway API key",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return "cancel";
  }
  const keyToUse = key.trim() || existingKey || "";
  const aiError = await testConnection("Verifying AI gateway API key…", () =>
    new OpenAiGatewayService({
      apiKey: keyToUse,
      baseUrl: readConfig().aiBaseUrl,
      model: readConfig().aiModel,
      maxDiffBytes: readConfig().aiMaxDiffBytes,
      http: httpOptionsFromConfig(),
    })
      .verify()
      .then(() => "AI ready")
  );
  if (aiError) {
    const choice = await vscode.window.showErrorMessage(
      `AI gateway check failed: ${aiError}`,
      "Re-enter details",
      "Save anyway",
      "Skip AI"
    );
    if (choice === "Re-enter details") {
      return "restart";
    }
    if (choice === "Skip AI") {
      await updateSetting("ai.enabled", false);
    }
    // "Save anyway" falls through to store the key below.
  }
  if (key.trim()) {
    await setOpenAiKey(ctx, key.trim());
  }
  return undefined;
}
