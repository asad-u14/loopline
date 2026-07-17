import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { createMockContext } from "./support/vscode-test-helpers";
import {
  readConfig,
  loadProjectConfig,
  readConfigForRepo,
  httpOptionsFromConfig,
  validateConfig,
  updateSetting,
  resetConfigWriteWarning,
  getJiraToken,
  setJiraToken,
  getGitLabToken,
  setGitLabToken,
  getAnthropicKey,
  setAnthropicKey,
  getOpenAiKey,
  setOpenAiKey,
  findMissingConfig,
  ensureConfigured,
} from "../src/util/config";
import { DEFAULT_BRANCH_TEMPLATE, DEFAULT_COMMIT_TEMPLATE } from "../src/util/text";
import { DEFAULT_CHANGELOG_CATEGORY_MAPPING } from "../src/util/changelog";

const dirs: string[] = [];

function mkRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loopline-cfg-")));
  dirs.push(dir);
  return dir;
}

function writeProjectFile(repoRoot: string, content: string): void {
  fs.writeFileSync(path.join(repoRoot, ".loopline.json"), content);
}

beforeEach(() => {
  vscode.__resetVscodeMock();
});

after(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

// ---- readConfig ----------------------------------------------------------------

test("readConfig: every default when nothing is configured", () => {
  const cfg = readConfig();
  assert.deepEqual(cfg, {
    jiraType: "cloud",
    jiraBaseUrl: "",
    jiraEmail: "",
    gitlabHost: "https://gitlab.com",
    gitlabProjectId: "",
    defaultTargetBranch: "main",
    branchTypeMapping: {},
    commitTypeMapping: {},
    confirmBranchName: true,
    includeJiraDescription: true,
    protectedBranches: ["main", "master", "develop"],
    jiraTransitionOnBranch: "",
    jiraTransitionOnMr: "",
    jiraTicketScope: "activeSprint",
    aiEnabled: false,
    aiProvider: "anthropic",
    aiModel: "claude-sonnet-5",
    aiBaseUrl: "https://api.anthropic.com",
    aiMaxDiffBytes: 60000,
    aiCheckDiffAgainstTicket: false,
    showTicketDetailsOnBranch: true,
    baseBranch: "",
    updateBaseBeforeBranch: "ask",
    groupTicketsByStatus: true,
    colorfulTicketIcons: true,
    impactMinutesPerBranch: 15,
    impactMinutesPerCommit: 5,
    impactMinutesPerMr: 10,
    staging: "respectStaged",
    singleCommit: "squash",
    httpProxy: "",
    httpExtraCaCerts: [],
    httpAllowInsecureTls: false,
    branchNameTemplate: DEFAULT_BRANCH_TEMPLATE,
    commitMessageTemplate: DEFAULT_COMMIT_TEMPLATE,
    changelogEnabled: false,
    changelogCategoryMapping: DEFAULT_CHANGELOG_CATEGORY_MAPPING,
  });
});

test("readConfig: every explicit override wins, with trimming/slash-stripping applied", () => {
  vscode.__setConfig("loopline", {
    "jira.type": "server",
    "jira.baseUrl": "https://acme.atlassian.net///",
    "jira.email": "dev@acme.com",
    "gitlab.host": "https://gitlab.acme.com//",
    "gitlab.projectId": "42",
    defaultTargetBranch: "develop",
    branchTypeMapping: { feature: "feat" },
    commitTypeMapping: { feature: "feat" },
    confirmBranchName: false,
    "mr.includeJiraDescription": false,
    protectedBranches: ["main"],
    "jira.transitionOnBranch": "  In Progress  ",
    "jira.transitionOnMr": "  In Review  ",
    "jira.ticketScope": "allOpen",
    "ai.enabled": true,
    "ai.provider": "openai",
    "ai.model": "  claude-opus  ",
    "ai.baseUrl": "  https://proxy.acme.com/ai//  ",
    "ai.maxDiffBytes": 12345,
    "ai.checkDiffAgainstTicket": true,
    showTicketDetailsOnBranch: false,
    baseBranch: "  release  ",
    updateBaseBeforeBranch: "always",
    "sidebar.groupByStatus": false,
    "sidebar.colorfulIcons": false,
    "impact.minutesPerBranch": 1,
    "impact.minutesPerCommit": 2,
    "impact.minutesPerMr": 3,
    staging: "pick",
    singleCommit: "off",
    "http.proxy": "  http://proxy.acme.com:8080  ",
    "http.extraCaCerts": ["/etc/ssl/ca.pem"],
    "http.allowInsecureTls": true,
    branchNameTemplate: "{ticket}",
    commitMessageTemplate: "{ticket}: {summary}",
    "changelog.enabled": true,
    "changelog.categoryMapping": { feature: "Added" },
  });

  const cfg = readConfig();
  assert.deepEqual(cfg, {
    jiraType: "server",
    jiraBaseUrl: "https://acme.atlassian.net",
    jiraEmail: "dev@acme.com",
    gitlabHost: "https://gitlab.acme.com",
    gitlabProjectId: "42",
    defaultTargetBranch: "develop",
    branchTypeMapping: { feature: "feat" },
    commitTypeMapping: { feature: "feat" },
    confirmBranchName: false,
    includeJiraDescription: false,
    protectedBranches: ["main"],
    jiraTransitionOnBranch: "In Progress",
    jiraTransitionOnMr: "In Review",
    jiraTicketScope: "allOpen",
    aiEnabled: true,
    aiProvider: "openai",
    aiModel: "claude-opus",
    aiBaseUrl: "https://proxy.acme.com/ai",
    aiMaxDiffBytes: 12345,
    aiCheckDiffAgainstTicket: true,
    showTicketDetailsOnBranch: false,
    baseBranch: "release",
    updateBaseBeforeBranch: "always",
    groupTicketsByStatus: false,
    colorfulTicketIcons: false,
    impactMinutesPerBranch: 1,
    impactMinutesPerCommit: 2,
    impactMinutesPerMr: 3,
    staging: "pick",
    singleCommit: "off",
    httpProxy: "http://proxy.acme.com:8080",
    httpExtraCaCerts: ["/etc/ssl/ca.pem"],
    httpAllowInsecureTls: true,
    branchNameTemplate: "{ticket}",
    commitMessageTemplate: "{ticket}: {summary}",
    changelogEnabled: true,
    changelogCategoryMapping: { feature: "Added" },
  });
});

test("readConfig: provider=openai with no model/baseUrl set defaults to empty, not the Anthropic values", () => {
  vscode.__setConfig("loopline", { "ai.provider": "openai" });
  const cfg = readConfig();
  assert.equal(cfg.aiProvider, "openai");
  assert.equal(cfg.aiModel, "");
  assert.equal(cfg.aiBaseUrl, "");
});

test("getOpenAiKey/setOpenAiKey: round-trips through secret storage, independent of the Anthropic key", async () => {
  const ctx = createMockContext();
  assert.equal(await getOpenAiKey(ctx), undefined);
  await setOpenAiKey(ctx, "gateway-key");
  assert.equal(await getOpenAiKey(ctx), "gateway-key");
  assert.equal(await getAnthropicKey(ctx), undefined);
});

// ---- loadProjectConfig ----------------------------------------------------------

test("loadProjectConfig: undefined when the file is absent", () => {
  const repo = mkRepo();
  assert.equal(loadProjectConfig(repo), undefined);
});

test("loadProjectConfig: parses and filters valid JSON", () => {
  const repo = mkRepo();
  writeProjectFile(
    repo,
    JSON.stringify({
      defaultTargetBranch: "develop",
      staging: "pick",
      unknownKey: "dropped",
    })
  );
  assert.deepEqual(loadProjectConfig(repo), {
    defaultTargetBranch: "develop",
    staging: "pick",
  });
});

test("loadProjectConfig: invalid JSON warns once per process and returns undefined both times", () => {
  const repo = mkRepo();
  writeProjectFile(repo, "{ not valid json");

  let warnCount = 0;
  let lastMessage = "";
  vscode.window.showWarningMessage = async (msg: string) => {
    warnCount++;
    lastMessage = msg;
    return undefined;
  };

  assert.equal(loadProjectConfig(repo), undefined);
  assert.equal(warnCount, 1);
  assert.match(lastMessage, /\.loopline\.json is invalid JSON/);

  // Second call on the same invalid file: still returns undefined, but the
  // module-level "already warned" flag means no second warning this process.
  assert.equal(loadProjectConfig(repo), undefined);
  assert.equal(warnCount, 1, "warns only once per process");
});

// ---- readConfigForRepo -----------------------------------------------------------

test("readConfigForRepo: no repoRoot returns plain readConfig()", () => {
  assert.deepEqual(readConfigForRepo(undefined), readConfig());
});

test("readConfigForRepo: repoRoot with no project file returns plain readConfig()", () => {
  const repo = mkRepo();
  assert.deepEqual(readConfigForRepo(repo), readConfig());
});

test("readConfigForRepo: repoRoot with an empty project file returns plain readConfig()", () => {
  const repo = mkRepo();
  writeProjectFile(repo, "{}");
  assert.deepEqual(readConfigForRepo(repo), readConfig());
});

const PROJECT_FILE_ALL_FIELDS = {
  branchTypeMapping: { feature: "feat" },
  commitTypeMapping: { feature: "feat" },
  protectedBranches: ["main", "release"],
  defaultTargetBranch: "develop",
  jiraTransitionOnBranch: "In Progress",
  jiraTransitionOnMr: "In Review",
  jiraTicketScope: "allOpen",
  staging: "pick",
  singleCommit: "off",
  branchNameTemplate: "{ticket}-proj",
  commitMessageTemplate: "{ticket}: proj {summary}",
  changelogEnabled: true,
  changelogCategoryMapping: { feature: "Added" },
};

test("readConfigForRepo: fills every mergeable field from the project file when nothing is explicit", () => {
  const repo = mkRepo();
  writeProjectFile(repo, JSON.stringify(PROJECT_FILE_ALL_FIELDS));

  const merged = readConfigForRepo(repo);
  assert.deepEqual(merged.branchTypeMapping, PROJECT_FILE_ALL_FIELDS.branchTypeMapping);
  assert.deepEqual(merged.commitTypeMapping, PROJECT_FILE_ALL_FIELDS.commitTypeMapping);
  assert.deepEqual(merged.protectedBranches, PROJECT_FILE_ALL_FIELDS.protectedBranches);
  assert.equal(merged.defaultTargetBranch, PROJECT_FILE_ALL_FIELDS.defaultTargetBranch);
  assert.equal(merged.jiraTransitionOnBranch, PROJECT_FILE_ALL_FIELDS.jiraTransitionOnBranch);
  assert.equal(merged.jiraTransitionOnMr, PROJECT_FILE_ALL_FIELDS.jiraTransitionOnMr);
  assert.equal(merged.jiraTicketScope, PROJECT_FILE_ALL_FIELDS.jiraTicketScope);
  assert.equal(merged.staging, PROJECT_FILE_ALL_FIELDS.staging);
  assert.equal(merged.singleCommit, PROJECT_FILE_ALL_FIELDS.singleCommit);
  assert.equal(merged.branchNameTemplate, PROJECT_FILE_ALL_FIELDS.branchNameTemplate);
  assert.equal(merged.commitMessageTemplate, PROJECT_FILE_ALL_FIELDS.commitMessageTemplate);
  assert.equal(merged.changelogEnabled, PROJECT_FILE_ALL_FIELDS.changelogEnabled);
  assert.deepEqual(merged.changelogCategoryMapping, PROJECT_FILE_ALL_FIELDS.changelogCategoryMapping);
});

test("readConfigForRepo: an explicit vscode setting always wins over the project file", () => {
  const repo = mkRepo();
  writeProjectFile(repo, JSON.stringify(PROJECT_FILE_ALL_FIELDS));

  vscode.__setConfig("loopline", {
    branchTypeMapping: { hotfix: "fix" },
    commitTypeMapping: { hotfix: "fix" },
    protectedBranches: ["trunk"],
    defaultTargetBranch: "trunk",
    "jira.transitionOnBranch": "Done",
    "jira.transitionOnMr": "Done",
    "jira.ticketScope": "activeSprint",
    staging: "all",
    singleCommit: "squash",
    branchNameTemplate: "{ticket}-explicit",
    commitMessageTemplate: "{ticket}: explicit {summary}",
    "changelog.enabled": false,
    "changelog.categoryMapping": { hotfix: "Fixed" },
  });

  const merged = readConfigForRepo(repo);
  assert.deepEqual(merged, readConfig());
});

// ---- httpOptionsFromConfig --------------------------------------------------------

test("httpOptionsFromConfig: defaults", () => {
  assert.deepEqual(httpOptionsFromConfig(), {
    proxy: undefined,
    extraCaCerts: [],
    allowInsecureTls: false,
  });
});

test("httpOptionsFromConfig: reflects explicit overrides", () => {
  vscode.__setConfig("loopline", {
    "http.proxy": "http://proxy.acme.com:8080",
    "http.extraCaCerts": ["/etc/ssl/ca.pem"],
    "http.allowInsecureTls": true,
  });
  assert.deepEqual(httpOptionsFromConfig(), {
    proxy: "http://proxy.acme.com:8080",
    extraCaCerts: ["/etc/ssl/ca.pem"],
    allowInsecureTls: true,
  });
});

// ---- validateConfig ---------------------------------------------------------------

test("validateConfig: no problems when nothing set (all defaults valid)", () => {
  assert.deepEqual(validateConfig(), []);
});

test("validateConfig: no problems with a fully valid explicit config", () => {
  vscode.__setConfig("loopline", {
    branchTypeMapping: { feature: "feat" },
    commitTypeMapping: { feature: "feat" },
    "jira.type": "cloud",
    "jira.baseUrl": "https://acme.atlassian.net",
    "gitlab.host": "https://gitlab.acme.com",
    protectedBranches: ["main"],
    "http.proxy": "http://proxy.acme.com:8080",
    "http.extraCaCerts": ["/etc/ssl/ca.pem"],
  });
  assert.deepEqual(validateConfig(), []);
});

test("validateConfig: flags a non string-map branchTypeMapping", () => {
  vscode.__setConfig("loopline", { branchTypeMapping: ["not", "a", "map"] });
  assert.ok(validateConfig().some((p) => p.includes("branchTypeMapping")));
});

test("validateConfig: flags a non string-map commitTypeMapping", () => {
  vscode.__setConfig("loopline", { commitTypeMapping: { feature: 5 } });
  assert.ok(validateConfig().some((p) => p.includes("commitTypeMapping")));
});

test("validateConfig: flags an invalid jira.type", () => {
  vscode.__setConfig("loopline", { "jira.type": "bogus" });
  assert.ok(validateConfig().some((p) => p.includes("jira.type")));
});

test("validateConfig: flags a jira.baseUrl without http(s)://", () => {
  vscode.__setConfig("loopline", { "jira.baseUrl": "acme.atlassian.net" });
  assert.ok(validateConfig().some((p) => p.includes("jira.baseUrl")));
});

test("validateConfig: flags a gitlab.host without http(s)://", () => {
  vscode.__setConfig("loopline", { "gitlab.host": "gitlab.acme.com" });
  assert.ok(validateConfig().some((p) => p.includes("gitlab.host")));
});

test("validateConfig: flags protectedBranches that isn't an array of strings", () => {
  vscode.__setConfig("loopline", { protectedBranches: "main" });
  assert.ok(validateConfig().some((p) => p.includes("protectedBranches")));
});

test("validateConfig: flags protectedBranches with a non-string entry", () => {
  vscode.__setConfig("loopline", { protectedBranches: ["main", 5] });
  assert.ok(validateConfig().some((p) => p.includes("protectedBranches")));
});

test("validateConfig: flags an http.proxy that isn't a URL", () => {
  vscode.__setConfig("loopline", { "http.proxy": "proxy.acme.com:8080" });
  assert.ok(validateConfig().some((p) => p.includes("http.proxy")));
});

test("validateConfig: flags http.extraCaCerts that isn't an array of strings", () => {
  vscode.__setConfig("loopline", { "http.extraCaCerts": "ca.pem" });
  assert.ok(validateConfig().some((p) => p.includes("http.extraCaCerts")));
});

test("validateConfig: flags http.extraCaCerts with a non-string entry", () => {
  vscode.__setConfig("loopline", { "http.extraCaCerts": [1, 2] });
  assert.ok(validateConfig().some((p) => p.includes("http.extraCaCerts")));
});

// ---- updateSetting / resetConfigWriteWarning ---------------------------------------

test("updateSetting: success path saves the value and returns true", async () => {
  const ok = await updateSetting("defaultTargetBranch", "develop");
  assert.equal(ok, true);
  assert.equal(readConfig().defaultTargetBranch, "develop");
});

test("updateSetting: failure path warns once, re-arms via resetConfigWriteWarning", async () => {
  vscode.workspace.getConfiguration = (_section?: string) => {
    return {
      get: () => undefined,
      has: () => false,
      inspect: () => ({ key: "x" }),
      update: async () => {
        throw new Error("not a registered configuration");
      },
    } as unknown as vscode.WorkspaceConfiguration;
  };

  let warnCount = 0;
  vscode.window.showWarningMessage = async () => {
    warnCount++;
    return undefined;
  };

  const first = await updateSetting("defaultTargetBranch", "develop");
  assert.equal(first, false);
  assert.equal(warnCount, 1);

  // Still failing, but the warning is one-shot until reset.
  const second = await updateSetting("defaultTargetBranch", "develop");
  assert.equal(second, false);
  assert.equal(warnCount, 1, "does not warn a second time before reset");

  resetConfigWriteWarning();

  const third = await updateSetting("defaultTargetBranch", "develop");
  assert.equal(third, false);
  assert.equal(warnCount, 2, "warns again after resetConfigWriteWarning()");
});

// ---- secrets wrappers ---------------------------------------------------------------

test("Jira token: get returns undefined until set, then round-trips", async () => {
  const ctx = createMockContext();
  assert.equal(await getJiraToken(ctx), undefined);
  await setJiraToken(ctx, "jira-tok");
  assert.equal(await getJiraToken(ctx), "jira-tok");
});

test("GitLab token: get returns undefined until set, then round-trips", async () => {
  const ctx = createMockContext();
  assert.equal(await getGitLabToken(ctx), undefined);
  await setGitLabToken(ctx, "gl-tok");
  assert.equal(await getGitLabToken(ctx), "gl-tok");
});

test("Anthropic key: get returns undefined until set, then round-trips", async () => {
  const ctx = createMockContext();
  assert.equal(await getAnthropicKey(ctx), undefined);
  await setAnthropicKey(ctx, "sk-ant-tok");
  assert.equal(await getAnthropicKey(ctx), "sk-ant-tok");
});

// ---- findMissingConfig ---------------------------------------------------------------

test("findMissingConfig: everything missing by default", async () => {
  const ctx = createMockContext();
  const missing = await findMissingConfig(ctx);
  assert.deepEqual(missing, [
    "Jira base URL",
    "Jira email (required for Cloud)",
    "Jira token",
    "GitLab token",
  ]);
});

test("findMissingConfig: empty when everything is configured (cloud)", async () => {
  const ctx = createMockContext();
  vscode.__setConfig("loopline", {
    "jira.baseUrl": "https://acme.atlassian.net",
    "jira.email": "dev@acme.com",
  });
  await setJiraToken(ctx, "jira-tok");
  await setGitLabToken(ctx, "gl-tok");
  assert.deepEqual(await findMissingConfig(ctx), []);
});

test("findMissingConfig: server type does not require an email", async () => {
  const ctx = createMockContext();
  vscode.__setConfig("loopline", {
    "jira.type": "server",
    "jira.baseUrl": "https://jira.acme.internal",
  });
  await setJiraToken(ctx, "jira-tok");
  await setGitLabToken(ctx, "gl-tok");
  assert.deepEqual(await findMissingConfig(ctx), []);
});

test("findMissingConfig: reports only the Jira token when everything else is set", async () => {
  const ctx = createMockContext();
  vscode.__setConfig("loopline", {
    "jira.baseUrl": "https://acme.atlassian.net",
    "jira.email": "dev@acme.com",
  });
  await setGitLabToken(ctx, "gl-tok");
  assert.deepEqual(await findMissingConfig(ctx), ["Jira token"]);
});

test("findMissingConfig: reports only the GitLab token when everything else is set", async () => {
  const ctx = createMockContext();
  vscode.__setConfig("loopline", {
    "jira.baseUrl": "https://acme.atlassian.net",
    "jira.email": "dev@acme.com",
  });
  await setJiraToken(ctx, "jira-tok");
  assert.deepEqual(await findMissingConfig(ctx), ["GitLab token"]);
});

// ---- ensureConfigured ---------------------------------------------------------------

test("ensureConfigured: returns true and prompts nothing when already configured", async () => {
  const ctx = createMockContext();
  vscode.__setConfig("loopline", {
    "jira.baseUrl": "https://acme.atlassian.net",
    "jira.email": "dev@acme.com",
  });
  await setJiraToken(ctx, "jira-tok");
  await setGitLabToken(ctx, "gl-tok");

  let warned = false;
  vscode.window.showWarningMessage = async () => {
    warned = true;
    return undefined;
  };

  assert.equal(await ensureConfigured(ctx), true);
  assert.equal(warned, false);
});

test("ensureConfigured: missing config -> warns and 'Cancel' leaves it unconfigured", async () => {
  const ctx = createMockContext();
  let warnedWith: string[] = [];
  vscode.window.showWarningMessage = (async (_msg: string, ...items: string[]) => {
    warnedWith = items;
    return "Cancel";
  }) as unknown as typeof vscode.window.showWarningMessage;

  assert.equal(await ensureConfigured(ctx), false);
  assert.deepEqual(warnedWith, ["Run Setup Wizard", "Cancel"]);
});

test("ensureConfigured: missing config -> 'Run Setup Wizard' executes loopline.runSetup", async () => {
  const ctx = createMockContext();
  vscode.window.showWarningMessage = async () => "Run Setup Wizard";

  let ran = false;
  vscode.commands.registerCommand("loopline.runSetup", () => {
    ran = true;
  });

  assert.equal(await ensureConfigured(ctx), false);
  assert.equal(ran, true);
});
