import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { createMockContext } from "./support/vscode-test-helpers";
import { initLog, log, logError, showLog } from "../src/util/log";

beforeEach(() => {
  (vscode as any).__resetVscodeMock();
});

function fakeChannel(onShow?: () => void) {
  const lines: string[] = [];
  return {
    lines,
    appendLine(s: string) {
      lines.push(s);
    },
    append(s: string) {
      lines.push(s);
    },
    clear() {
      lines.length = 0;
    },
    show(_preserveFocus?: boolean) {
      onShow?.();
    },
    hide() {},
    dispose() {},
  } as unknown as vscode.OutputChannel & { lines: string[] };
}

test("initLog: creates an output channel and registers it for disposal", () => {
  const ctx = createMockContext();
  initLog(ctx);
  assert.equal(ctx.subscriptions.length, 1);
});

test("log: appends a timestamped line to the channel", () => {
  const ctx = createMockContext();
  const channel = fakeChannel();
  (vscode.window as any).createOutputChannel = () => channel;
  initLog(ctx);

  log("hello world");

  assert.equal(channel.lines.length, 1);
  assert.match(channel.lines[0], /^\[\d{4}-\d{2}-\d{2}T.*Z\] hello world$/);
});

test("logError: appends a timestamped ERROR line including the error message", () => {
  const ctx = createMockContext();
  const channel = fakeChannel();
  (vscode.window as any).createOutputChannel = () => channel;
  initLog(ctx);

  logError("something failed", new Error("boom"));

  assert.equal(channel.lines.length, 1);
  assert.match(channel.lines[0], /ERROR: something failed — boom$/);
});

test("logError: works with a non-Error thrown value", () => {
  const ctx = createMockContext();
  const channel = fakeChannel();
  (vscode.window as any).createOutputChannel = () => channel;
  initLog(ctx);

  logError("something failed", "raw string cause");

  assert.match(channel.lines[0], /ERROR: something failed — raw string cause$/);
});

test("logError: with no err argument omits the detail suffix", () => {
  const ctx = createMockContext();
  const channel = fakeChannel();
  (vscode.window as any).createOutputChannel = () => channel;
  initLog(ctx);

  logError("something failed");

  assert.equal(channel.lines.length, 1);
  assert.match(channel.lines[0], /ERROR: something failed$/);
});

test("showLog: reveals the output channel without throwing", () => {
  const ctx = createMockContext();
  let shown = false;
  const channel = fakeChannel(() => {
    shown = true;
  });
  (vscode.window as any).createOutputChannel = () => channel;
  initLog(ctx);

  assert.doesNotThrow(() => showLog());
  assert.equal(shown, true);
});
