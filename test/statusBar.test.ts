import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import * as vscode from "vscode";
import { createMockContext } from "./support/vscode-test-helpers";
import { TicketStatusBar } from "../src/ui/statusBar";
import { GitService } from "../src/services/git";

const dirs: string[] = [];

function makeRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loopline-statusbar-")));
  dirs.push(repo);
  run(repo, "git init -q -b main");
  run(repo, 'git config user.name "t"');
  run(repo, 'git config user.email "t@t.co"');
  return repo;
}

function run(cwd: string, cmd: string) {
  execSync(cmd, { cwd, stdio: "ignore" });
}

function commit(repo: string, file: string, content: string, message: string) {
  fs.writeFileSync(path.join(repo, file), content);
  run(repo, `git add -A`);
  run(repo, `git commit -q -m "${message}"`);
}

function setWorkspace(repo: string) {
  vscode.__setWorkspaceFolders([
    { uri: vscode.Uri.file(repo), name: path.basename(repo), index: 0 },
  ] as any);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

after(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

beforeEach(() => {
  vscode.__resetVscodeMock();
});

test("constructor: registers the status bar item and event listeners as subscriptions", () => {
  const ctx = createMockContext();
  const before = ctx.subscriptions.length;
  new TicketStatusBar(ctx);
  assert.equal(ctx.subscriptions.length, before + 4);
});

test("constructor: sets the item's command", () => {
  const ctx = createMockContext();
  let captured: any;
  const origCreate = vscode.window.createStatusBarItem;
  vscode.window.createStatusBarItem = (...args: any[]) => {
    captured = origCreate();
    return captured;
  };
  new TicketStatusBar(ctx);
  assert.equal(captured.command, "loopline.ticketActions");
});

test("constructor: a focused window-state change triggers a refresh, an unfocused one doesn't", async () => {
  const ctx = createMockContext();
  let capturedCb: ((s: { focused: boolean }) => void) | undefined;
  (vscode.window as any).onDidChangeWindowState = (cb: any) => {
    capturedCb = cb;
    return { dispose() {} };
  };

  const bar = new TicketStatusBar(ctx);
  let refreshCalls = 0;
  const origRefresh = bar.refresh.bind(bar);
  bar.refresh = async () => {
    refreshCalls++;
    return origRefresh();
  };

  capturedCb!({ focused: false });
  await Promise.resolve();
  assert.equal(refreshCalls, 0);

  capturedCb!({ focused: true });
  await Promise.resolve();
  assert.equal(refreshCalls, 1);
});

test("refresh: no repo -> item hidden, state undefined", async () => {
  const ctx = createMockContext();
  const bar = new TicketStatusBar(ctx);
  await bar.refresh();
  assert.equal(bar.getState(), undefined);
});

test("refresh: repo with a branch matching the ticket convention sets text/tooltip", async () => {
  const repo = makeRepo();
  commit(repo, "a.txt", "1", "init");
  run(repo, "git checkout -q -b feature/LPB-42-do-thing");
  setWorkspace(repo);

  const ctx = createMockContext();
  const bar = new TicketStatusBar(ctx);
  await bar.refresh();

  const state = bar.getState();
  assert.equal(state?.ticket, "LPB-42");
  assert.equal(state?.branch, "feature/LPB-42-do-thing");
});

test("refresh: repo with a branch NOT matching the convention -> 'no ticket in branch name' tooltip", async () => {
  const repo = makeRepo();
  commit(repo, "a.txt", "1", "init");
  run(repo, "git checkout -q -b just-a-branch");
  setWorkspace(repo);

  const ctx = createMockContext();
  const bar = new TicketStatusBar(ctx);
  await bar.refresh();

  const state = bar.getState();
  assert.equal(state?.ticket, undefined);
  assert.equal(state?.branch, "just-a-branch");
});

test("refresh: currentBranch() throwing -> 'no branch' tooltip", async () => {
  const repo = makeRepo();
  commit(repo, "a.txt", "1", "init");
  setWorkspace(repo);

  const orig = GitService.prototype.currentBranch;
  GitService.prototype.currentBranch = async () => {
    throw new Error("boom");
  };
  try {
    const ctx = createMockContext();
    const bar = new TicketStatusBar(ctx);
    await bar.refresh();
    const state = bar.getState();
    assert.equal(state?.branch, "");
    assert.equal(state?.ticket, undefined);
  } finally {
    GitService.prototype.currentBranch = orig;
  }
});

test("ensureHeadWatcher: same repo root across refresh() calls creates the watcher only once", async () => {
  const repo = makeRepo();
  commit(repo, "a.txt", "1", "init");
  setWorkspace(repo);

  let createCount = 0;
  const origCreate = vscode.workspace.createFileSystemWatcher;
  vscode.workspace.createFileSystemWatcher = (...args: any[]) => {
    createCount++;
    return (origCreate as any)(...args);
  };

  const ctx = createMockContext();
  const bar = new TicketStatusBar(ctx);
  await bar.refresh();
  await bar.refresh();
  assert.equal(createCount, 1);
});

test("ensureHeadWatcher: a different repo root disposes the old watcher and creates a new one", async () => {
  const repoA = makeRepo();
  commit(repoA, "a.txt", "1", "init");
  const repoB = makeRepo();
  commit(repoB, "b.txt", "1", "init");

  const disposed: any[] = [];
  const origCreate = vscode.workspace.createFileSystemWatcher;
  vscode.workspace.createFileSystemWatcher = (...args: any[]) => {
    const w = (origCreate as any)(...args);
    const origDispose = w.dispose.bind(w);
    w.dispose = () => {
      disposed.push(w);
      origDispose();
    };
    return w;
  };

  const ctx = createMockContext();
  const bar = new TicketStatusBar(ctx);

  setWorkspace(repoA);
  await bar.refresh();
  assert.equal(disposed.length, 0);

  setWorkspace(repoB);
  await bar.refresh();
  assert.equal(disposed.length, 1);
});

test("watcher change/create events trigger a refresh", async () => {
  const repo = makeRepo();
  commit(repo, "a.txt", "1", "init");
  setWorkspace(repo);

  let watcher: any;
  const origCreate = vscode.workspace.createFileSystemWatcher;
  vscode.workspace.createFileSystemWatcher = (...args: any[]) => {
    watcher = (origCreate as any)(...args);
    return watcher;
  };

  const ctx = createMockContext();
  const bar = new TicketStatusBar(ctx);
  await bar.refresh();
  assert.equal(bar.getState()?.ticket, undefined);

  run(repo, "git checkout -q -b feature/LPB-7-x");
  watcher._change();
  await waitFor(() => bar.getState()?.ticket === "LPB-7");

  run(repo, "git checkout -q main");
  watcher._create();
  await waitFor(() => bar.getState()?.ticket === undefined);
});

test("dispose: disposes both the watcher (if any) and the item", async () => {
  const repo = makeRepo();
  commit(repo, "a.txt", "1", "init");
  setWorkspace(repo);

  let watcherDisposed = false;
  const origCreate = vscode.workspace.createFileSystemWatcher;
  vscode.workspace.createFileSystemWatcher = (...args: any[]) => {
    const w = (origCreate as any)(...args);
    const origDispose = w.dispose.bind(w);
    w.dispose = () => {
      watcherDisposed = true;
      origDispose();
    };
    return w;
  };

  let itemDisposed = false;
  const origCreateItem = vscode.window.createStatusBarItem;
  vscode.window.createStatusBarItem = () => {
    const item = (origCreateItem as any)();
    const origDispose = item.dispose.bind(item);
    item.dispose = () => {
      itemDisposed = true;
      origDispose();
    };
    return item;
  };

  const ctx = createMockContext();
  const bar = new TicketStatusBar(ctx);
  await bar.refresh();

  bar.dispose();
  assert.equal(watcherDisposed, true);
  assert.equal(itemDisposed, true);
});

test("dispose: no-watcher-yet case still disposes the item cleanly", () => {
  const ctx = createMockContext();
  let itemDisposed = false;
  const origCreateItem = vscode.window.createStatusBarItem;
  vscode.window.createStatusBarItem = () => {
    const item = (origCreateItem as any)();
    const origDispose = item.dispose.bind(item);
    item.dispose = () => {
      itemDisposed = true;
      origDispose();
    };
    return item;
  };
  const bar = new TicketStatusBar(ctx);
  bar.dispose();
  assert.equal(itemDisposed, true);
});
