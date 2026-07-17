import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import * as vscode from "vscode";
import { createMockContext } from "./support/vscode-test-helpers";
import { startMockServer, MockServer } from "./support/mock-server";
import {
  resolveRepoRoot,
  currentRepoQuiet,
  tryTransitionTicket,
  buildJiraService,
  buildGitLabService,
  buildAnthropicService,
  resolveGitLabProject,
} from "../src/util/workspace";
import { GitService } from "../src/services/git";

const dirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function run(cmd: string, cwd: string) {
  execSync(cmd, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.co",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.co",
    },
  });
}

function makeRepo(prefix = "loopline-ws-"): string {
  const repo = mkTmpDir(prefix);
  run("git init -q -b main", repo);
  run('git config user.name "t"', repo);
  run('git config user.email "t@t.co"', repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
  run("git add -A", repo);
  run('git commit -q -m "init"', repo);
  return repo;
}

function workspaceFolder(root: string) {
  return { uri: vscode.Uri.file(root), name: path.basename(root), index: 0 };
}

after(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

beforeEach(() => {
  vscode.__resetVscodeMock();
});

// ---- resolveRepoRoot --------------------------------------------------------

test("resolveRepoRoot: no workspace folders -> error message, undefined", async () => {
  let errMsg: string | undefined;
  vscode.window.showErrorMessage = (async (m: string) => {
    errMsg = m;
    return undefined;
  }) as any;

  const root = await resolveRepoRoot(createMockContext());
  assert.equal(root, undefined);
  assert.match(errMsg!, /open a folder or workspace first/);
});

test("resolveRepoRoot: active editor's file resolves its repo and is remembered", async () => {
  const repo = makeRepo();
  const other = makeRepo();
  vscode.__setWorkspaceFolders([workspaceFolder(other)]);
  vscode.__setActiveTextEditor({ document: { uri: vscode.Uri.file(path.join(repo, "a.txt")) } } as any);

  const ctx = createMockContext();
  const root = await resolveRepoRoot(ctx);
  assert.equal(root, fs.realpathSync(repo));
  assert.equal(ctx.workspaceState.get("loopline.lastRepoRoot"), fs.realpathSync(repo));
});

test("resolveRepoRoot: active editor with a non-file scheme is ignored, falls through to workspace discovery", async () => {
  const repo = makeRepo();
  vscode.__setWorkspaceFolders([workspaceFolder(repo)]);
  vscode.__setActiveTextEditor({ document: { uri: vscode.Uri.parse("untitled:Untitled-1") } } as any);

  const root = await resolveRepoRoot(createMockContext());
  assert.equal(root, fs.realpathSync(repo));
});

test("resolveRepoRoot: single discovered repo across workspace folders is used directly", async () => {
  const repo = makeRepo();
  vscode.__setWorkspaceFolders([workspaceFolder(repo)]);

  const ctx = createMockContext();
  const root = await resolveRepoRoot(ctx);
  assert.equal(root, fs.realpathSync(repo));
  assert.equal(ctx.workspaceState.get("loopline.lastRepoRoot"), fs.realpathSync(repo));
});

test("resolveRepoRoot: no repo discoverable -> error message, undefined", async () => {
  const empty = mkTmpDir("loopline-ws-empty-");
  vscode.__setWorkspaceFolders([workspaceFolder(empty)]);
  let errMsg: string | undefined;
  vscode.window.showErrorMessage = (async (m: string) => {
    errMsg = m;
    return undefined;
  }) as any;

  const root = await resolveRepoRoot(createMockContext());
  assert.equal(root, undefined);
  assert.match(errMsg!, /no git repository found/);
});

test("resolveRepoRoot: a container folder with nested repos discovers each one", async () => {
  const container = mkTmpDir("loopline-ws-container-");
  const repoA = path.join(container, "repo-a");
  const repoB = path.join(container, "repo-b");
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  run("git init -q -b main", repoA);
  run('git config user.name "t"', repoA);
  run('git config user.email "t@t.co"', repoA);
  fs.writeFileSync(path.join(repoA, "a.txt"), "1\n");
  run("git add -A", repoA);
  run('git commit -q -m "init"', repoA);
  run("git init -q -b main", repoB);
  run('git config user.name "t"', repoB);
  run('git config user.email "t@t.co"', repoB);
  fs.writeFileSync(path.join(repoB, "b.txt"), "1\n");
  run("git add -A", repoB);
  run('git commit -q -m "init"', repoB);
  // A directory in the skip-list must not be scanned as a candidate repo.
  fs.mkdirSync(path.join(container, "node_modules"));

  vscode.__setWorkspaceFolders([workspaceFolder(container)]);
  let pickedTitle: string | undefined;
  vscode.window.showQuickPick = (async (items: any[], opts: any) => {
    pickedTitle = opts?.title;
    return items[0];
  }) as any;

  const root = await resolveRepoRoot(createMockContext());
  assert.ok(root === fs.realpathSync(repoA) || root === fs.realpathSync(repoB));
  assert.equal(pickedTitle, "Loopline: which repository?");
});

test("resolveRepoRoot: multiple repos -> quickpick, cancelled returns undefined", async () => {
  const container = mkTmpDir("loopline-ws-multi-");
  const repoA = path.join(container, "repo-a");
  const repoB = path.join(container, "repo-b");
  for (const r of [repoA, repoB]) {
    fs.mkdirSync(r);
    run("git init -q -b main", r);
    run('git config user.name "t"', r);
    run('git config user.email "t@t.co"', r);
    fs.writeFileSync(path.join(r, "f.txt"), "1\n");
    run("git add -A", r);
    run('git commit -q -m "init"', r);
  }
  vscode.__setWorkspaceFolders([workspaceFolder(container)]);
  vscode.window.showQuickPick = (async () => undefined) as any;

  const root = await resolveRepoRoot(createMockContext());
  assert.equal(root, undefined);
});

test("resolveRepoRoot: multiple repos -> the last-used one sorts first and is marked in its detail", async () => {
  const container = mkTmpDir("loopline-ws-multi2-");
  const repoA = path.join(container, "repo-a");
  const repoB = path.join(container, "repo-b");
  for (const r of [repoA, repoB]) {
    fs.mkdirSync(r);
    run("git init -q -b main", r);
    run('git config user.name "t"', r);
    run('git config user.email "t@t.co"', r);
    fs.writeFileSync(path.join(r, "f.txt"), "1\n");
    run("git add -A", r);
    run('git commit -q -m "init"', r);
  }
  vscode.__setWorkspaceFolders([workspaceFolder(container)]);
  const ctx = createMockContext();
  await ctx.workspaceState.update("loopline.lastRepoRoot", fs.realpathSync(repoB));

  let items: any[] = [];
  vscode.window.showQuickPick = (async (its: any[]) => {
    items = its;
    return its[0];
  }) as any;

  const root = await resolveRepoRoot(ctx);
  assert.equal(root, fs.realpathSync(repoB));
  assert.equal(items[0].repoPath, fs.realpathSync(repoB));
  assert.match(items[0].detail, /last used/);
  assert.match(items[0].description, /\$\(git-branch\) main/);
});

// ---- currentRepoQuiet --------------------------------------------------------

test("currentRepoQuiet: no workspace folders -> undefined, no prompt", async () => {
  const root = await currentRepoQuiet(createMockContext());
  assert.equal(root, undefined);
});

test("currentRepoQuiet: active editor's file resolves its repo without prompting", async () => {
  const repo = makeRepo();
  vscode.__setActiveTextEditor({ document: { uri: vscode.Uri.file(path.join(repo, "a.txt")) } } as any);
  vscode.__setWorkspaceFolders([workspaceFolder(repo)]);

  const root = await currentRepoQuiet(createMockContext());
  assert.equal(root, fs.realpathSync(repo));
});

test("currentRepoQuiet: no repos discoverable -> undefined", async () => {
  const empty = mkTmpDir("loopline-ws-empty2-");
  vscode.__setWorkspaceFolders([workspaceFolder(empty)]);
  const root = await currentRepoQuiet(createMockContext());
  assert.equal(root, undefined);
});

test("currentRepoQuiet: prefers the remembered last-used repo among several", async () => {
  const container = mkTmpDir("loopline-ws-quiet-multi-");
  const repoA = path.join(container, "repo-a");
  const repoB = path.join(container, "repo-b");
  for (const r of [repoA, repoB]) {
    fs.mkdirSync(r);
    run("git init -q -b main", r);
    run('git config user.name "t"', r);
    run('git config user.email "t@t.co"', r);
    fs.writeFileSync(path.join(r, "f.txt"), "1\n");
    run("git add -A", r);
    run('git commit -q -m "init"', r);
  }
  vscode.__setWorkspaceFolders([workspaceFolder(container)]);
  const ctx = createMockContext();
  await ctx.workspaceState.update("loopline.lastRepoRoot", fs.realpathSync(repoB));

  const root = await currentRepoQuiet(ctx);
  assert.equal(root, fs.realpathSync(repoB));
});

test("currentRepoQuiet: falls back to the first discovered repo when nothing is remembered", async () => {
  const repo = makeRepo();
  vscode.__setWorkspaceFolders([workspaceFolder(repo)]);
  const root = await currentRepoQuiet(createMockContext());
  assert.equal(root, fs.realpathSync(repo));
});

// ---- buildJiraService / buildGitLabService / buildAnthropicService ----------

test("buildJiraService: no token -> undefined", async () => {
  vscode.__setConfig("loopline", { "jira.baseUrl": "https://acme.atlassian.net" });
  const svc = await buildJiraService(createMockContext());
  assert.equal(svc, undefined);
});

test("buildJiraService: token but no base URL -> undefined", async () => {
  const ctx = createMockContext();
  await ctx.secrets.store("loopline.jira.token", "tok");
  const svc = await buildJiraService(ctx);
  assert.equal(svc, undefined);
});

test("buildJiraService: token + base URL -> a real service instance", async () => {
  vscode.__setConfig("loopline", { "jira.baseUrl": "https://acme.atlassian.net" });
  const ctx = createMockContext();
  await ctx.secrets.store("loopline.jira.token", "tok");
  const svc = await buildJiraService(ctx);
  assert.ok(svc);
});

test("buildGitLabService: no token -> undefined", async () => {
  const svc = await buildGitLabService(createMockContext());
  assert.equal(svc, undefined);
});

test("buildGitLabService: token present -> a real service instance", async () => {
  const ctx = createMockContext();
  await ctx.secrets.store("loopline.gitlab.token", "tok");
  const svc = await buildGitLabService(ctx);
  assert.ok(svc);
});

test("buildAnthropicService: AI disabled -> undefined even with a key", async () => {
  vscode.__setConfig("loopline", { "ai.enabled": false });
  const ctx = createMockContext();
  await ctx.secrets.store("loopline.anthropic.apiKey", "key");
  const svc = await buildAnthropicService(ctx);
  assert.equal(svc, undefined);
});

test("buildAnthropicService: AI enabled but no key -> undefined", async () => {
  vscode.__setConfig("loopline", { "ai.enabled": true });
  const svc = await buildAnthropicService(createMockContext());
  assert.equal(svc, undefined);
});

test("buildAnthropicService: AI enabled + key -> a real service instance", async () => {
  vscode.__setConfig("loopline", { "ai.enabled": true });
  const ctx = createMockContext();
  await ctx.secrets.store("loopline.anthropic.apiKey", "key");
  const svc = await buildAnthropicService(ctx);
  assert.ok(svc);
});

// ---- resolveGitLabProject -----------------------------------------------------

test("resolveGitLabProject: pinned setting wins over origin auto-detection", async () => {
  vscode.__setConfig("loopline", { "gitlab.projectId": "42" });
  const repo = makeRepo();
  const project = await resolveGitLabProject(new GitService(repo));
  assert.equal(project, "42");
});

test("resolveGitLabProject: falls back to auto-detecting from the origin remote", async () => {
  const repo = makeRepo();
  run("git remote add origin git@gitlab.com:group/project.git", repo);
  const project = await resolveGitLabProject(new GitService(repo));
  assert.equal(project, "group/project");
});

test("resolveGitLabProject: no pinned id and no origin -> undefined", async () => {
  const repo = makeRepo();
  const project = await resolveGitLabProject(new GitService(repo));
  assert.equal(project, undefined);
});

// ---- tryTransitionTicket -----------------------------------------------------

test("tryTransitionTicket: empty targetStatus -> no-op, no Jira call", async () => {
  const ctx = createMockContext();
  await ctx.secrets.store("loopline.jira.token", "tok");
  vscode.__setConfig("loopline", { "jira.baseUrl": "https://acme.atlassian.net" });
  let called = false;
  vscode.window.showInformationMessage = (async () => {
    called = true;
    return undefined;
  }) as any;
  await tryTransitionTicket(ctx, "LPB-1", "");
  assert.equal(called, false);
});

test("tryTransitionTicket: Jira not configured -> no-op", async () => {
  const ctx = createMockContext();
  await tryTransitionTicket(ctx, "LPB-1", "Done");
  // No assertion needed beyond "doesn't throw" — nothing to configure means nothing to do.
});

test("tryTransitionTicket: applied -> shows an info message", async () => {
  const server = await startMockServer([
    { status: 200, body: { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] } },
    { status: 204, body: {} },
  ]);
  try {
    vscode.__setConfig("loopline", { "jira.baseUrl": server.url });
    const ctx = createMockContext();
    await ctx.secrets.store("loopline.jira.token", "tok");

    let info: string | undefined;
    vscode.window.showInformationMessage = (async (m: string) => {
      info = m;
      return undefined;
    }) as any;

    await tryTransitionTicket(ctx, "LPB-1", "Done");
    assert.match(info!, /LPB-1 moved to "Done"/);
  } finally {
    await server.close();
  }
});

test("tryTransitionTicket: no matching transition -> shows a warning with what's skipped", async () => {
  const server = await startMockServer([
    { status: 200, body: { transitions: [{ id: "11", name: "Start", to: { name: "In Progress" } }] } },
  ]);
  try {
    vscode.__setConfig("loopline", { "jira.baseUrl": server.url });
    const ctx = createMockContext();
    await ctx.secrets.store("loopline.jira.token", "tok");

    let warned: string | undefined;
    vscode.window.showWarningMessage = (async (m: string) => {
      warned = m;
      return undefined;
    }) as any;

    await tryTransitionTicket(ctx, "LPB-1", "Done");
    assert.match(warned!, /LPB-1 not moved/);
  } finally {
    await server.close();
  }
});

test("tryTransitionTicket: a Jira failure surfaces as a warning, doesn't throw", async () => {
  const server = await startMockServer([{ status: 401, body: {} }]);
  try {
    vscode.__setConfig("loopline", { "jira.baseUrl": server.url });
    const ctx = createMockContext();
    await ctx.secrets.store("loopline.jira.token", "tok");

    let warned: string | undefined;
    vscode.window.showWarningMessage = (async (m: string) => {
      warned = m;
      return undefined;
    }) as any;

    await tryTransitionTicket(ctx, "LPB-1", "Done");
    assert.match(warned!, /couldn't transition LPB-1/);
  } finally {
    await server.close();
  }
});
