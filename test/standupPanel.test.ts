import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { showStandupSummary, StandupSummary } from "../src/ui/standupPanel";

let capturedPanel: any;

beforeEach(() => {
  vscode.__resetVscodeMock();
  capturedPanel = undefined;
  const origCreate = vscode.window.createWebviewPanel;
  vscode.window.createWebviewPanel = (...args: any[]) => {
    capturedPanel = (origCreate as any)(...args);
    return capturedPanel;
  };
});

afterEach(() => {
  // The module keeps a top-level singleton `panel`; disposing the fake panel
  // fires its own onDidDispose handler which resets that singleton to
  // undefined, so the next test starts fresh.
  if (capturedPanel) {
    capturedPanel.dispose();
  }
});

function detail(overrides: Partial<StandupSummary> = {}): StandupSummary {
  return {
    dateLabel: "Jul 17",
    markdown: "- did a thing",
    aiGenerated: false,
    ...overrides,
  };
}

test("first call creates a webview panel with the expected viewType", () => {
  showStandupSummary(detail());
  assert.equal(capturedPanel.viewType, "looplineStandup");
  assert.equal(capturedPanel.title, "Standup — Jul 17");
  assert.match(capturedPanel.webview.html, /Standup — Jul 17/);
});

test("second call reuses the same panel instead of creating a new one", () => {
  showStandupSummary(detail({ dateLabel: "Jul 17" }));
  const first = capturedPanel;
  let revealCount = 0;
  const origReveal = first.reveal.bind(first);
  first.reveal = (...args: any[]) => {
    revealCount++;
    origReveal(...args);
  };

  let createCalls = 0;
  const origCreate = vscode.window.createWebviewPanel;
  vscode.window.createWebviewPanel = (...args: any[]) => {
    createCalls++;
    return (origCreate as any)(...args);
  };

  showStandupSummary(detail({ dateLabel: "Jul 18" }));
  assert.equal(createCalls, 0, "createWebviewPanel must not be called again");
  assert.equal(capturedPanel, first);
  assert.equal(first.title, "Standup — Jul 18");
  assert.equal(revealCount, 1);
});

test("copy message writes the current markdown to the clipboard and sets a status bar message", async () => {
  const md = "- line one\n- line two";
  showStandupSummary(detail({ markdown: md }));

  let statusMsg: string | undefined;
  vscode.window.setStatusBarMessage = ((msg: string) => {
    statusMsg = msg;
    return { dispose() {} };
  }) as any;

  capturedPanel.webview._receiveMessage({ type: "copy" });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(await vscode.env.clipboard.readText(), md);
  assert.match(statusMsg || "", /copied/);
});

test("messages other than 'copy' are ignored", async () => {
  showStandupSummary(detail());
  await vscode.env.clipboard.writeText("");
  capturedPanel.webview._receiveMessage({ type: "somethingElse" });
  await Promise.resolve();
  assert.equal(await vscode.env.clipboard.readText(), "");
});

test("rendered HTML escapes special characters in the date label", () => {
  showStandupSummary(detail({ dateLabel: `<b>&"'>` }));
  assert.match(capturedPanel.webview.html, /&lt;b&gt;&amp;/);
  assert.doesNotMatch(capturedPanel.webview.html, /<b>&"/);
});

test("rendered HTML reflects aiGenerated: true wording", () => {
  showStandupSummary(detail({ aiGenerated: true }));
  assert.match(capturedPanel.webview.html, /AI-drafted from today's commits/);
});

test("rendered HTML reflects aiGenerated: false wording", () => {
  showStandupSummary(detail({ aiGenerated: false }));
  assert.match(capturedPanel.webview.html, /Plain list from today's commits/);
});
