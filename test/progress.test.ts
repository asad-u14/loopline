import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { OperationCancelled, isCancelled, withCancellableProgress } from "../src/util/progress";

beforeEach(() => {
  (vscode as any).__resetVscodeMock();
});

test("isCancelled: true for OperationCancelled, false for other errors/values", () => {
  assert.equal(isCancelled(new OperationCancelled()), true);
  assert.equal(isCancelled(new Error("nope")), false);
  assert.equal(isCancelled(undefined), false);
  assert.equal(isCancelled("string"), false);
});

test("OperationCancelled: has the expected name and message", () => {
  const err = new OperationCancelled();
  assert.equal(err.name, "OperationCancelled");
  assert.equal(err.message, "Operation cancelled");
  assert.ok(err instanceof Error);
});

test("withCancellableProgress: runs fn and resolves with its result", async () => {
  const source = new (vscode as any).CancellationTokenSource();
  const reported: unknown[] = [];
  vscode.window.withProgress = async (_options: unknown, fn: any) => {
    const progress = { report: (m: unknown) => reported.push(m) };
    return fn(progress, source.token);
  };

  const result = await withCancellableProgress("Doing thing", async (_signal, report) => {
    report("step 1");
    return "done";
  });

  assert.equal(result, "done");
  assert.deepEqual(reported, [{ message: "step 1" }]);
});

test("withCancellableProgress: report() forwards messages to progress.report({message})", async () => {
  const source = new (vscode as any).CancellationTokenSource();
  const reported: unknown[] = [];
  vscode.window.withProgress = async (_options: unknown, fn: any) => {
    const progress = { report: (m: unknown) => reported.push(m) };
    return fn(progress, source.token);
  };

  await withCancellableProgress("Title", async (_signal, report) => {
    report("first");
    report("second");
  });

  assert.deepEqual(reported, [{ message: "first" }, { message: "second" }]);
});

test("withCancellableProgress: cancelling the token aborts the signal mid-flight", async () => {
  const source = new (vscode as any).CancellationTokenSource();
  vscode.window.withProgress = async (_options: unknown, fn: any) => {
    return fn({ report() {} }, source.token);
  };

  let sawAbortedInsideFn = false;
  const result = withCancellableProgress("Title", async (signal) => {
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        sawAbortedInsideFn = signal.aborted;
        resolve("cancelled-path");
      });
      // Cancel while fn is in flight.
      source.cancel();
    });
  });

  assert.equal(await result, "cancelled-path");
  assert.equal(sawAbortedInsideFn, true);
});

test("withCancellableProgress: passes the location/title/cancellable options through", async () => {
  let seenOptions: any;
  vscode.window.withProgress = async (options: unknown, fn: any) => {
    seenOptions = options;
    const source = new (vscode as any).CancellationTokenSource();
    return fn({ report() {} }, source.token);
  };

  await withCancellableProgress("My Title", async () => "ok");

  assert.equal(seenOptions.title, "My Title");
  assert.equal(seenOptions.cancellable, true);
  assert.equal(seenOptions.location, vscode.ProgressLocation.Notification);
});

test("withCancellableProgress: disposes the cancellation subscription after completion (success)", async () => {
  let disposeCalls = 0;
  const source = new (vscode as any).CancellationTokenSource();
  const realOnCancellationRequested = source.token.onCancellationRequested;
  source.token.onCancellationRequested = (listener: any) => {
    const sub = realOnCancellationRequested(listener);
    return {
      dispose: () => {
        disposeCalls++;
        sub.dispose();
      },
    };
  };
  vscode.window.withProgress = async (_options: unknown, fn: any) => {
    return fn({ report() {} }, source.token);
  };

  await withCancellableProgress("Title", async () => "ok");

  assert.equal(disposeCalls, 1);
});

test("withCancellableProgress: disposes the cancellation subscription after completion (failure)", async () => {
  let disposeCalls = 0;
  const source = new (vscode as any).CancellationTokenSource();
  const realOnCancellationRequested = source.token.onCancellationRequested;
  source.token.onCancellationRequested = (listener: any) => {
    const sub = realOnCancellationRequested(listener);
    return {
      dispose: () => {
        disposeCalls++;
        sub.dispose();
      },
    };
  };
  vscode.window.withProgress = async (_options: unknown, fn: any) => {
    return fn({ report() {} }, source.token);
  };

  await assert.rejects(
    async () =>
      withCancellableProgress("Title", async () => {
        throw new Error("boom");
      }),
    /boom/
  );

  assert.equal(disposeCalls, 1);
});
