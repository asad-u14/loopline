import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import type { AddressInfo } from "net";
import * as vscode from "vscode";
import { createMockContext } from "./support/vscode-test-helpers";
import { showTicketDetail, TicketDetail } from "../src/ui/ticketDetailPanel";
import { startMockServer, MockServer } from "./support/mock-server";

/** Like startMockServer, but delays the response — needed to give a cancellation
 * a real window to land in before the response arrives. */
function startDelayedServer(delayMs: number, status: number, body: unknown): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

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
  if (capturedPanel) {
    capturedPanel.dispose();
  }
});

function detail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    key: "LPB-42",
    summary: "Do the thing",
    issueType: "Story",
    status: "In Progress",
    description: "Some description",
    jiraBaseUrl: "https://acme.atlassian.net",
    ...overrides,
  };
}

async function flush(times = 3) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * Poll until `predicate` is true or `timeoutMs` elapses. Needed anywhere a real
 * HTTP round-trip is involved: microtask-only flushing (`flush()` above) never
 * lets a real socket connect/respond, since that requires the event loop's
 * poll phase. Leaving such a request unawaited and moving on (e.g. by only
 * flushing microtasks before asserting) causes the test to fail its own
 * assertion AND leaves a dangling in-flight request that resolves/rejects
 * later, against whatever panel is current by then — corrupting a later test.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("first call creates a webview panel with the expected viewType", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail());
  assert.equal(capturedPanel.viewType, "looplineTicket");
  assert.equal(capturedPanel.title, "LPB-42");
});

test("second call reuses the same panel instead of creating a new one", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ key: "LPB-1" }));
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

  showTicketDetail(ctx, detail({ key: "LPB-2" }));
  assert.equal(createCalls, 0);
  assert.equal(capturedPanel, first);
  assert.equal(first.title, "LPB-2");
  assert.equal(revealCount, 1);
});

test("rendered HTML shows the generate button when AI is enabled", () => {
  vscode.__setConfig("loopline", { "ai.enabled": true });
  const ctx = createMockContext();
  showTicketDetail(ctx, detail());
  assert.match(capturedPanel.webview.html, /id="generate"/);
});

test("rendered HTML hides the generate button when AI is disabled", () => {
  vscode.__setConfig("loopline", { "ai.enabled": false });
  const ctx = createMockContext();
  showTicketDetail(ctx, detail());
  assert.doesNotMatch(capturedPanel.webview.html, /id="generate"/);
});

// ---- openJira ---------------------------------------------------------------

test("openJira: opens the ticket URL externally when jiraBaseUrl is set", async () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ jiraBaseUrl: "https://acme.atlassian.net" }));

  let openedUri: any;
  vscode.env.openExternal = (async (uri: any) => {
    openedUri = uri;
    return true;
  }) as any;

  capturedPanel.webview._receiveMessage({ type: "openJira" });
  await flush();
  assert.equal(openedUri?.toString(), "https://acme.atlassian.net/browse/LPB-42");
});

test("openJira: does nothing when jiraBaseUrl is empty", async () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ jiraBaseUrl: "" }));

  let opened = false;
  vscode.env.openExternal = (async () => {
    opened = true;
    return true;
  }) as any;

  capturedPanel.webview._receiveMessage({ type: "openJira" });
  await flush();
  assert.equal(opened, false);
});

// ---- openParentJira -----------------------------------------------------------

test("openParentJira: opens the parent ticket URL externally", async () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ parent: { key: "LPB-1", summary: "Parent story" } }));

  let openedUri: any;
  vscode.env.openExternal = (async (uri: any) => {
    openedUri = uri;
    return true;
  }) as any;

  capturedPanel.webview._receiveMessage({ type: "openParentJira" });
  await flush();
  assert.equal(openedUri?.toString(), "https://acme.atlassian.net/browse/LPB-1");
});

test("openParentJira: does nothing when there's no parent", async () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail());

  let opened = false;
  vscode.env.openExternal = (async () => {
    opened = true;
    return true;
  }) as any;

  capturedPanel.webview._receiveMessage({ type: "openParentJira" });
  await flush();
  assert.equal(opened, false);
});

// ---- copyKey --------------------------------------------------------------------

test("copyKey: writes the ticket key to the clipboard and confirms back to the webview", async () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ key: "LPB-77" }));

  capturedPanel.webview._receiveMessage({ type: "copyKey" });
  await flush();

  assert.equal(await vscode.env.clipboard.readText(), "LPB-77");
  const messages = capturedPanel.webview._postedMessages;
  assert.ok(messages.some((m: any) => m.type === "copied"));
});

// ---- rendered HTML: metadata, status color, skeleton ---------------------------

test("rendered HTML: color-codes the status chip by category", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ statusCategory: "done" }));
  assert.match(capturedPanel.webview.html, /class="chip chip-status chip-status-done"/);
});

test("rendered HTML: an unknown status category doesn't get a color class on the chip itself", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ statusCategory: undefined }));
  assert.match(capturedPanel.webview.html, /class="chip chip-status "/);
});

test("rendered HTML: loading shows a skeleton instead of the real description", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ loading: true, description: "" }));
  assert.match(capturedPanel.webview.html, /class="skeleton skeleton-line"/);
  assert.doesNotMatch(capturedPanel.webview.html, /No description on this ticket/);
});

test("rendered HTML: not loading shows the real description, not a skeleton", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ loading: false }));
  assert.doesNotMatch(capturedPanel.webview.html, /class="skeleton skeleton-line"/);
});

test("rendered HTML: shows a parent/epic breadcrumb when a parent is present", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ parent: { key: "LPB-1", summary: "Parent story" } }));
  assert.match(capturedPanel.webview.html, /id="openParent"/);
  assert.match(capturedPanel.webview.html, /LPB-1: Parent story/);
});

test("rendered HTML: no breadcrumb when there's no parent", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail());
  assert.doesNotMatch(capturedPanel.webview.html, /id="openParent"/);
});

test("rendered HTML: shows an overdue due date distinctly", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ dueDate: "2000-01-01" }));
  assert.match(capturedPanel.webview.html, /Overdue by/);
  assert.match(capturedPanel.webview.html, /class="overdue"/);
});

test("rendered HTML: includes a copy-key button next to the ticket key", () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail());
  assert.match(capturedPanel.webview.html, /id="copyKey"/);
});

// ---- createBranch -------------------------------------------------------------

test("createBranch: executes loopline.tickets.createBranch with the ticket key", async () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail({ key: "LPB-99" }));

  const calls: { id: string; args: unknown[] }[] = [];
  const origExec = vscode.commands.executeCommand;
  vscode.commands.executeCommand = (async (id: string, ...args: unknown[]) => {
    calls.push({ id, args });
    return (origExec as any)(id, ...args);
  }) as any;

  capturedPanel.webview._receiveMessage({ type: "createBranch" });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "loopline.tickets.createBranch");
  assert.deepEqual(calls[0].args, ["LPB-99"]);
});

// ---- generate / generatePlan --------------------------------------------------

test("generate: AI not configured posts a planError", async () => {
  vscode.__setConfig("loopline", { "ai.enabled": false });
  const ctx = createMockContext();
  showTicketDetail(ctx, detail());

  capturedPanel.webview._receiveMessage({ type: "generate" });
  await flush();

  const messages = capturedPanel.webview._postedMessages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "planError");
  assert.match(messages[0].message, /AI isn't enabled/);
});

test("generate: AI enabled but no key posts a planError", async () => {
  vscode.__setConfig("loopline", { "ai.enabled": true });
  const ctx = createMockContext();
  // no secret stored
  showTicketDetail(ctx, detail());

  capturedPanel.webview._receiveMessage({ type: "generate" });
  await flush();

  const messages = capturedPanel.webview._postedMessages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "planError");
});

test("generate: success posts planLoading then plan with the generated HTML", async () => {
  const server = await startMockServer([
    { status: 200, body: { content: [{ type: "text", text: "## Step 1\nDo the thing." }] } },
  ]);
  try {
    vscode.__setConfig("loopline", {
      "ai.enabled": true,
      "ai.baseUrl": server.url,
      "ai.model": "claude-x",
    });
    const ctx = createMockContext();
    await ctx.secrets.store("loopline.anthropic.apiKey", "key");
    showTicketDetail(ctx, detail());

    capturedPanel.webview._receiveMessage({ type: "generate" });
    await waitFor(() => capturedPanel.webview._postedMessages.some((m: any) => m.type === "plan"));

    const messages = capturedPanel.webview._postedMessages;
    assert.equal(messages[0].type, "planLoading");
    const planMsg = messages.find((m: any) => m.type === "plan");
    assert.ok(planMsg, "expected a plan message");
    assert.match(planMsg.html, /Step 1/);
  } finally {
    await server.close();
  }
});

test("generate: a failing Anthropic call posts planLoading then planError", async () => {
  const server = await startMockServer([{ status: 500, body: { error: { message: "boom" } } }]);
  try {
    vscode.__setConfig("loopline", {
      "ai.enabled": true,
      "ai.baseUrl": server.url,
      "ai.model": "claude-x",
    });
    const ctx = createMockContext();
    await ctx.secrets.store("loopline.anthropic.apiKey", "key");
    showTicketDetail(ctx, detail());

    capturedPanel.webview._receiveMessage({ type: "generate" });
    await waitFor(() => capturedPanel.webview._postedMessages.some((m: any) => m.type === "planError"));

    const messages = capturedPanel.webview._postedMessages;
    assert.equal(messages[0].type, "planLoading");
    const errMsg = messages.find((m: any) => m.type === "planError");
    assert.ok(errMsg, "expected a planError message");
  } finally {
    await server.close();
  }
});

test("generate: cancelling mid-request posts a 'Cancelled.' planError", async () => {
  const server = await startDelayedServer(300, 200, {
    content: [{ type: "text", text: "too slow" }],
  });
  try {
    vscode.__setConfig("loopline", {
      "ai.enabled": true,
      "ai.baseUrl": server.url,
      "ai.model": "claude-x",
    });
    const ctx = createMockContext();
    await ctx.secrets.store("loopline.anthropic.apiKey", "key");
    showTicketDetail(ctx, detail());

    vscode.window.withProgress = (async (_opts: unknown, fn: any) => {
      const progress = { report() {} };
      const source = new vscode.CancellationTokenSource();
      const resultPromise = fn(progress, source.token);
      setTimeout(() => source.cancel(), 30);
      return resultPromise;
    }) as any;

    capturedPanel.webview._receiveMessage({ type: "generate" });
    await waitFor(() => capturedPanel.webview._postedMessages.some((m: any) => m.type === "planError"));

    const messages = capturedPanel.webview._postedMessages;
    const errMsg = messages.find((m: any) => m.type === "planError");
    assert.ok(errMsg, "expected a planError message");
    assert.equal(errMsg.message, "Cancelled.");
  } finally {
    await server.close();
  }
});

test("generate: message handling is a no-op once the panel/current has been reset (dispose then message)", async () => {
  const ctx = createMockContext();
  showTicketDetail(ctx, detail());
  const panel = capturedPanel;
  panel.dispose(); // resets module-internal `current` to undefined
  capturedPanel = undefined;
  // Directly invoke the (now-orphaned) receive-message listener; it should
  // see `current === undefined` and return without posting anything.
  panel.webview._receiveMessage({ type: "generate" });
  await flush();
  assert.equal(panel.webview._postedMessages.length, 0);
});
