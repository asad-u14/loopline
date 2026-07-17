import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraService, JiraError } from "../src/services/jira";
import { startMockServer } from "./support/mock-server";
import { OperationCancelled } from "../src/util/progress";

function cloudService(baseUrl: string): JiraService {
  return new JiraService({ type: "cloud", baseUrl, email: "dev@acme.com", token: "tok" });
}

// Nothing listens here, so requests fail fast with ECONNREFUSED — used to exercise
// the pickCode/explainNetworkCode "couldn't reach" branches without a live server.
const UNREACHABLE = "http://127.0.0.1:1";

// ---- verify(): network fallback ---------------------------------------------------

test("verify: an unreachable host surfaces the network explanation", async () => {
  await assert.rejects(() => cloudService(UNREACHABLE).verify(), /Couldn't reach Jira/);
});

// ---- getIssue: description edge cases ----------------------------------------------

test("getIssue: a missing description renders as an empty string", async () => {
  const server = await startMockServer([
    {
      status: 200,
      body: {
        key: "LPB-3",
        fields: { summary: "S", issuetype: { name: "Task" }, status: { name: "To Do" } },
      },
    },
  ]);
  try {
    const issue = await cloudService(server.url).getIssue("LPB-3");
    assert.equal(issue.description, "");
  } finally {
    await server.close();
  }
});

test("getIssue: the ADF walk skips falsy nodes within content arrays", async () => {
  const adf = {
    type: "doc",
    content: [{ type: "paragraph", content: [null, { type: "text", text: "Hello" }] }],
  };
  const server = await startMockServer([
    {
      status: 200,
      body: {
        key: "LPB-4",
        fields: { summary: "S", issuetype: { name: "Task" }, description: adf, status: { name: "To Do" } },
      },
    },
  ]);
  try {
    const issue = await cloudService(server.url).getIssue("LPB-4");
    assert.match(issue.description, /Hello/);
  } finally {
    await server.close();
  }
});

test("getIssue: 401 is turned into a re-run-the-setup-wizard message", async () => {
  const server = await startMockServer([{ status: 401, body: {} }]);
  try {
    await assert.rejects(() => cloudService(server.url).getIssue("LPB-1"), /re-run the setup wizard/i);
  } finally {
    await server.close();
  }
});

test("getIssue: an unreachable host surfaces the network explanation", async () => {
  await assert.rejects(() => cloudService(UNREACHABLE).getIssue("LPB-1"), /Couldn't reach Jira/);
});

// ---- getMyOpenIssues: sprint-fallback and error edge cases -------------------------

test("getMyOpenIssues: if the sprint-less retry also fails, that error surfaces", async () => {
  const server = await startMockServer([
    { status: 400, body: { errorMessages: ["Field 'sprint' does not exist"] } },
    { status: 500, body: {} },
  ]);
  try {
    await assert.rejects(() => cloudService(server.url).getMyOpenIssues(undefined, true));
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test("getMyOpenIssues: an already-aborted signal cancels the request", async () => {
  const server = await startMockServer([{ status: 200, body: { issues: [] } }]);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => cloudService(server.url).getMyOpenIssues(controller.signal, true),
      (err: Error) => {
        assert.ok(err instanceof OperationCancelled);
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("getMyOpenIssues: a non-400 error is not treated as sprint-unsupported (no retry)", async () => {
  const server = await startMockServer([{ status: 500, body: {} }]);
  try {
    await assert.rejects(() => cloudService(server.url).getMyOpenIssues(undefined, true));
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("getMyOpenIssues: sprint-unsupported detection also matches the `errors` object shape", async () => {
  const server = await startMockServer([
    {
      status: 400,
      body: { errors: { sprint: "Field 'sprint' does not exist or you do not have permission to view it." } },
    },
    { status: 200, body: { issues: [] } },
  ]);
  try {
    const result = await cloudService(server.url).getMyOpenIssues(undefined, true);
    assert.equal(result.sprintFilterApplied, false);
  } finally {
    await server.close();
  }
});

test("getMyOpenIssues: sprint-unsupported detection also matches a plain-string body", async () => {
  const server = await startMockServer([
    { status: 400, body: "Error: sprint field unsupported on this board" },
    { status: 200, body: { issues: [] } },
  ]);
  try {
    const result = await cloudService(server.url).getMyOpenIssues(undefined, true);
    assert.equal(result.sprintFilterApplied, false);
  } finally {
    await server.close();
  }
});

// ---- transitions: error paths -------------------------------------------------------

test("getTransitions: a non-200 response is turned into a friendly error", async () => {
  const server = await startMockServer([{ status: 500, body: {} }]);
  try {
    await assert.rejects(() => cloudService(server.url).getTransitions("LPB-1"), JiraError);
  } finally {
    await server.close();
  }
});

test("transitionTo: an error applying the chosen transition surfaces as a friendly error", async () => {
  const server = await startMockServer([
    { status: 200, body: { transitions: [{ id: "21", name: "In Progress", to: { name: "In Progress" } }] } },
    { status: 500, body: {} },
  ]);
  try {
    await assert.rejects(() => cloudService(server.url).transitionTo("LPB-1", "In Progress"), JiraError);
  } finally {
    await server.close();
  }
});
