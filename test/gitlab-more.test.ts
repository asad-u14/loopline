import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import type { AddressInfo } from "net";
import { GitLabService, GitLabError } from "../src/services/gitlab";
import { startMockServer } from "./support/mock-server";
import { OperationCancelled } from "../src/util/progress";

function service(baseUrl: string): GitLabService {
  return new GitLabService(baseUrl, "tok");
}

/**
 * Like startMockServer, but each route can delay its reply — needed to create a
 * window in which an in-flight request can actually be aborted mid-request.
 */
interface DelayedRoute {
  status: number;
  body?: unknown;
  delayMs?: number;
}

function startDelayedServer(routes: DelayedRoute[]): Promise<{ url: string; close(): Promise<void> }> {
  let i = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const route = routes[Math.min(i, routes.length - 1)];
      i++;
      const send = () => {
        res.writeHead(route.status, { "content-type": "application/json" });
        res.end(JSON.stringify(route.body ?? {}));
      };
      if (route.delayMs) {
        setTimeout(send, route.delayMs);
      } else {
        send();
      }
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

// Nothing listens here, so requests fail fast with ECONNREFUSED — used to exercise
// the pickCode/explainNetworkCode "couldn't reach" branches without a live server.
const UNREACHABLE = "http://127.0.0.1:1";

// ---- verify(): cancellation ------------------------------------------------------

test("verify: an already-aborted signal cancels the request", async () => {
  const server = await startMockServer([{ status: 200, body: { username: "ada" } }]);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => service(server.url).verify(controller.signal),
      (err: Error) => {
        assert.ok(err instanceof OperationCancelled);
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("verify: aborting mid-flight during the /version fallback still surfaces as cancelled", async () => {
  const server = await startDelayedServer([
    { status: 403 },
    { status: 200, body: { version: "17.0.0" }, delayMs: 200 },
  ]);
  try {
    const controller = new AbortController();
    const promise = service(server.url).verify(controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(promise, (err: Error) => {
      assert.ok(err instanceof OperationCancelled);
      return true;
    });
  } finally {
    await server.close();
  }
});

// ---- verify(): network / unmapped-status fallbacks --------------------------------

test("verify: an unreachable host surfaces the network explanation", async () => {
  await assert.rejects(
    () => service(UNREACHABLE).verify(),
    (err: GitLabError) => {
      assert.match(err.message, /Couldn't reach GitLab/);
      return true;
    }
  );
});

test("verify: an unmapped status falls back to axios's own message", async () => {
  const server = await startMockServer([{ status: 500, body: {} }]);
  try {
    await assert.rejects(() => service(server.url).verify(), (err: GitLabError) => {
      assert.equal(err.status, 500);
      return true;
    });
  } finally {
    await server.close();
  }
});

// ---- findOpenMR: error paths -------------------------------------------------------

test("findOpenMR: a non-200 response is turned into a friendly error", async () => {
  const server = await startMockServer([{ status: 500, body: {} }]);
  try {
    await assert.rejects(
      () => service(server.url).findOpenMR("group/project", "feature/x"),
      GitLabError
    );
  } finally {
    await server.close();
  }
});

test("findOpenMR: an already-aborted signal cancels the request", async () => {
  const server = await startMockServer([{ status: 200, body: [] }]);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => service(server.url).findOpenMR("group/project", "feature/x", controller.signal),
      (err: Error) => {
        assert.ok(err instanceof OperationCancelled);
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

// ---- createMR: error paths ---------------------------------------------------------

test("createMR: 401 is rejected with a re-run-setup message", async () => {
  const server = await startMockServer([{ status: 401, body: {} }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).createMR("group/project", {
          sourceBranch: "feature/x",
          targetBranch: "main",
          title: "t",
          description: "d",
        }),
      /Re-run setup/
    );
  } finally {
    await server.close();
  }
});

test("createMR: an unreachable host surfaces the network explanation", async () => {
  await assert.rejects(
    () =>
      service(UNREACHABLE).createMR("group/project", {
        sourceBranch: "feature/x",
        targetBranch: "main",
        title: "t",
        description: "d",
      }),
    /Couldn't reach GitLab/
  );
});
