import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicService, AnthropicError } from "../src/services/anthropic";
import { startMockServer } from "./support/mock-server";
import { OperationCancelled } from "../src/util/progress";

function service(baseUrl: string, maxDiffBytes = 60000): AnthropicService {
  return new AnthropicService({ apiKey: "test-key", baseUrl, model: "claude-sonnet-5", maxDiffBytes });
}

// Nothing listens here, so requests fail fast with ECONNREFUSED — used to exercise
// the pickCode/explainNetworkCode "couldn't reach" branch without a live server.
const UNREACHABLE = "http://127.0.0.1:1";

// ---- verify(): cancellation + network fallback -------------------------------------

test("verify: an already-aborted signal cancels the request", async () => {
  const server = await startMockServer([{ status: 200, body: { content: [] } }]);
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

test("verify: an unreachable host surfaces the network explanation", async () => {
  await assert.rejects(() => service(UNREACHABLE).verify(), /Couldn't reach the Anthropic endpoint/);
});

// ---- extractText: non-array content -------------------------------------------------

test("generateMrDescription: a response with no content array is treated as empty", async () => {
  const server = await startMockServer([{ status: 200, body: {} }]);
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

// ---- generateImplementationPlan: empty response + error path ------------------------

test("generateImplementationPlan: an empty text response is treated as an error", async () => {
  const server = await startMockServer([{ status: 200, body: { content: [] } }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).generateImplementationPlan({
          ticketKey: "LPB-1",
          summary: "",
          description: "",
          issueType: "Story",
          repoLayout: [],
        }),
      /empty response/i
    );
  } finally {
    await server.close();
  }
});

test("generateImplementationPlan: a non-200 response is turned into a friendly error", async () => {
  const server = await startMockServer([{ status: 500, body: {} }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).generateImplementationPlan({
          ticketKey: "LPB-1",
          summary: "",
          description: "",
          issueType: "Story",
          repoLayout: [],
        }),
      AnthropicError
    );
  } finally {
    await server.close();
  }
});

// ---- checkDiffAgainstTicket: empty response + error path ----------------------------

test("checkDiffAgainstTicket: an empty text response is treated as an error", async () => {
  const server = await startMockServer([{ status: 200, body: { content: [] } }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).checkDiffAgainstTicket({
          ticketKey: "LPB-1",
          ticketSummary: "",
          ticketDescription: "",
          diff: "d",
        }),
      /empty response/i
    );
  } finally {
    await server.close();
  }
});

test("checkDiffAgainstTicket: a non-200 response is turned into a friendly error", async () => {
  const server = await startMockServer([{ status: 500, body: {} }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).checkDiffAgainstTicket({
          ticketKey: "LPB-1",
          ticketSummary: "",
          ticketDescription: "",
          diff: "d",
        }),
      AnthropicError
    );
  } finally {
    await server.close();
  }
});

// ---- generateStandupSummary: empty response + error path ----------------------------

test("generateStandupSummary: an empty text response is treated as an error", async () => {
  const server = await startMockServer([{ status: 200, body: { content: [] } }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).generateStandupSummary({
          dateLabel: "today",
          groups: [{ ticketKey: "LPB-1", subjects: ["feat: LPB-1 add login"] }],
        }),
      /empty response/i
    );
  } finally {
    await server.close();
  }
});

test("generateStandupSummary: a non-200 response is turned into a friendly error", async () => {
  const server = await startMockServer([{ status: 500, body: {} }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).generateStandupSummary({
          dateLabel: "today",
          groups: [{ ticketKey: "LPB-1", subjects: ["feat: LPB-1 add login"] }],
        }),
      AnthropicError
    );
  } finally {
    await server.close();
  }
});
