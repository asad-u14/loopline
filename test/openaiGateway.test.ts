import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiGatewayService, OpenAiGatewayError } from "../src/services/openaiGateway";
import { startMockServer } from "./support/mock-server";
import { OperationCancelled } from "../src/util/progress";

function service(baseUrl: string, maxDiffBytes = 60000): OpenAiGatewayService {
  return new OpenAiGatewayService({ apiKey: "test-key", baseUrl, model: "bedrock-claude-sonnet-4-5", maxDiffBytes });
}

// Nothing listens here, so requests fail fast with ECONNREFUSED — used to exercise
// the connection-error / explainNetworkCode branch without a live server. (Port 1 is
// on fetch's forbidden-ports list and fails differently, so use a high port instead.)
const UNREACHABLE = "http://127.0.0.1:65533";

// ---- verify() + error mapping ------------------------------------------------

test("verify: succeeds on a normal response", async () => {
  const server = await startMockServer([
    { status: 200, body: { choices: [{ message: { content: "pong" } }] } },
  ]);
  try {
    await assert.doesNotReject(() => service(server.url).verify());
  } finally {
    await server.close();
  }
});

test("verify: 401 -> friendly key-rejected message", async () => {
  const server = await startMockServer([{ status: 401, body: { error: { message: "invalid api key" } } }]);
  try {
    await assert.rejects(() => service(server.url).verify(), (err: OpenAiGatewayError) => {
      assert.match(err.message, /rejected the API key/i);
      assert.equal(err.status, 401);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("verify: 403 -> permission hint, not a bare status code", async () => {
  const server = await startMockServer([
    { status: 403, body: { error: { message: "model access denied for this key" } } },
  ]);
  try {
    await assert.rejects(() => service(server.url).verify(), (err: OpenAiGatewayError) => {
      assert.match(err.message, /403/);
      assert.match(err.message, /model access denied for this key/);
      assert.equal(err.status, 403);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("verify: 400 mentioning the model -> model-specific hint", async () => {
  const server = await startMockServer([
    { status: 400, body: { error: { message: "model: bogus-model is not a valid model ID" } } },
  ]);
  try {
    await assert.rejects(() => service(server.url).verify(), (err: OpenAiGatewayError) => {
      assert.match(err.message, /Model not accepted/);
      assert.match(err.message, /loopline\.ai\.model/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("verify: 404 -> base URL hint", async () => {
  const server = await startMockServer([{ status: 404, body: {} }]);
  try {
    await assert.rejects(() => service(server.url).verify(), (err: OpenAiGatewayError) => {
      assert.match(err.message, /404/);
      assert.match(err.message, /baseUrl/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("verify: 429 -> rate-limit message", async () => {
  const server = await startMockServer([{ status: 429, body: {} }]);
  try {
    await assert.rejects(() => service(server.url).verify(), (err: OpenAiGatewayError) => {
      assert.match(err.message, /Rate limited/);
      assert.equal(err.status, 429);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("verify: unrecognized status surfaces the gateway's own error message", async () => {
  const server = await startMockServer([{ status: 418, body: { error: { message: "I'm a teapot" } } }]);
  try {
    await assert.rejects(() => service(server.url).verify(), (err: OpenAiGatewayError) => {
      assert.equal(err.message, "I'm a teapot");
      assert.equal(err.status, 418);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("verify: an unreachable host surfaces the network explanation", async () => {
  await assert.rejects(() => service(UNREACHABLE).verify(), /Couldn't reach the AI gateway endpoint/);
});

test("verify: an already-aborted signal cancels the request", async () => {
  const server = await startMockServer([{ status: 200, body: { choices: [{ message: { content: "pong" } }] } }]);
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

// ---- generateMrDescription ---------------------------------------------------

test("generateMrDescription: sends the ticket/diff and extracts the message content", async () => {
  const server = await startMockServer([
    { status: 200, body: { choices: [{ message: { content: "## Summary\nDoes the thing." } }] } },
  ]);
  try {
    const text = await service(server.url).generateMrDescription({
      ticketKey: "LPB-1",
      ticketSummary: "Add login",
      ticketDescription: "Users need to log in",
      sourceBranch: "feature/LPB-1-login",
      targetBranch: "main",
      changedFiles: ["src/auth.ts"],
      diff: "diff --git a/src/auth.ts b/src/auth.ts",
    });
    assert.equal(text, "## Summary\nDoes the thing.");

    const [req] = server.requests;
    const payload = JSON.parse(req.body);
    assert.equal(payload.model, "bedrock-claude-sonnet-4-5");
    assert.equal(payload.messages[0].role, "system");
    assert.equal(payload.messages[1].role, "user");
    assert.match(payload.messages[1].content, /LPB-1/);
    assert.match(payload.messages[1].content, /feature\/LPB-1-login → main/);
  } finally {
    await server.close();
  }
});

test("generateMrDescription: an empty message content is treated as an error", async () => {
  const server = await startMockServer([{ status: 200, body: { choices: [{ message: { content: "" } }] } }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).generateMrDescription({
          ticketKey: "LPB-1",
          ticketSummary: "",
          ticketDescription: "",
          sourceBranch: "feature/LPB-1-x",
          targetBranch: "main",
          changedFiles: [],
          diff: "d",
        }),
      /empty response/i
    );
  } finally {
    await server.close();
  }
});

test("generateMrDescription: a response with no choices is treated as empty", async () => {
  const server = await startMockServer([{ status: 200, body: { choices: [] } }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).generateMrDescription({
          ticketKey: "LPB-1",
          ticketSummary: "",
          ticketDescription: "",
          sourceBranch: "feature/x",
          targetBranch: "main",
          changedFiles: [],
          diff: "d",
        }),
      /empty response/i
    );
  } finally {
    await server.close();
  }
});

// ---- the other AI features, happy-path wiring only (error mapping is shared) --

test("generateImplementationPlan: returns the drafted plan text", async () => {
  const server = await startMockServer([
    { status: 200, body: { choices: [{ message: { content: "## Goal\nShip it." } }] } },
  ]);
  try {
    const text = await service(server.url).generateImplementationPlan({
      ticketKey: "LPB-1",
      summary: "Add login",
      description: "",
      issueType: "Story",
      repoLayout: ["src/"],
    });
    assert.equal(text, "## Goal\nShip it.");
  } finally {
    await server.close();
  }
});

test("checkDiffAgainstTicket: returns the verdict text", async () => {
  const server = await startMockServer([
    { status: 200, body: { choices: [{ message: { content: "VERDICT: LOOKS COMPLETE\nAll good." } }] } },
  ]);
  try {
    const text = await service(server.url).checkDiffAgainstTicket({
      ticketKey: "LPB-1",
      ticketSummary: "Add login",
      ticketDescription: "",
      diff: "diff --git a/x b/x",
    });
    assert.match(text, /VERDICT: LOOKS COMPLETE/);
  } finally {
    await server.close();
  }
});

test("generateStandupSummary: returns the drafted summary text", async () => {
  const server = await startMockServer([
    { status: 200, body: { choices: [{ message: { content: "- LPB-1: added login" } }] } },
  ]);
  try {
    const text = await service(server.url).generateStandupSummary({
      dateLabel: "today",
      repos: [{ repoName: "loopline", groups: [{ ticketKey: "LPB-1", subjects: ["feat: LPB-1 add login"] }] }],
    });
    assert.equal(text, "- LPB-1: added login");
  } finally {
    await server.close();
  }
});
