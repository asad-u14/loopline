import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraService, JiraError } from "../src/services/jira";
import { startMockServer } from "./support/mock-server";

function cloudService(baseUrl: string): JiraService {
  return new JiraService({ type: "cloud", baseUrl, email: "dev@acme.com", token: "tok" });
}

function serverService(baseUrl: string): JiraService {
  return new JiraService({ type: "server", baseUrl, email: "", token: "pat-tok" });
}

// ---- auth header shape --------------------------------------------------------

test("cloud auth: Basic base64(email:token)", async () => {
  const server = await startMockServer([{ status: 200, body: { displayName: "Dev" } }]);
  try {
    await cloudService(server.url).verify();
    const expected = `Basic ${Buffer.from("dev@acme.com:tok").toString("base64")}`;
    assert.equal(server.requests[0].headers.authorization, expected);
  } finally {
    await server.close();
  }
});

test("server auth: Bearer token", async () => {
  const server = await startMockServer([{ status: 200, body: { displayName: "Dev" } }]);
  try {
    await serverService(server.url).verify();
    assert.equal(server.requests[0].headers.authorization, "Bearer pat-tok");
  } finally {
    await server.close();
  }
});

// ---- verify() -----------------------------------------------------------------

test("verify: succeeds and returns the display name", async () => {
  const server = await startMockServer([{ status: 200, body: { displayName: "Ada" } }]);
  try {
    assert.equal(await cloudService(server.url).verify(), "Ada");
  } finally {
    await server.close();
  }
});

test("verify: 401 gives a Cloud-specific hint", async () => {
  const server = await startMockServer([{ status: 401, body: {} }]);
  try {
    await assert.rejects(() => cloudService(server.url).verify(), (err: JiraError) => {
      assert.match(err.message, /email \+ API token/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("verify: 403 on Server/DC gives a PAT-specific hint", async () => {
  const server = await startMockServer([{ status: 403, body: {} }]);
  try {
    await assert.rejects(() => serverService(server.url).verify(), (err: JiraError) => {
      assert.match(err.message, /Personal Access Token/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("verify: 404 -> base URL hint", async () => {
  const server = await startMockServer([{ status: 404, body: {} }]);
  try {
    await assert.rejects(() => cloudService(server.url).verify(), /base URL is probably wrong/);
  } finally {
    await server.close();
  }
});

// ---- getIssue -----------------------------------------------------------------

test("getIssue: normalizes a plain-string (Server-style) description", async () => {
  const server = await startMockServer([
    {
      status: 200,
      body: {
        key: "LPB-1",
        fields: {
          summary: "Fix login",
          issuetype: { name: "Bug" },
          description: "Plain text description",
          status: { name: "In Progress" },
        },
      },
    },
  ]);
  try {
    const issue = await cloudService(server.url).getIssue("LPB-1");
    assert.deepEqual(issue, {
      key: "LPB-1",
      summary: "Fix login",
      issueType: "Bug",
      description: "Plain text description",
      status: "In Progress",
      assignee: undefined,
      reporter: undefined,
      priority: undefined,
      labels: [],
      created: undefined,
      updated: undefined,
    });
  } finally {
    await server.close();
  }
});

test("getIssue: flattens an ADF (Cloud-style) description to plain text", async () => {
  const adf = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Users can't log in." }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Reproduce with any account." }],
      },
    ],
  };
  const server = await startMockServer([
    {
      status: 200,
      body: {
        key: "LPB-2",
        fields: { summary: "Login broken", issuetype: { name: "Bug" }, description: adf, status: { name: "To Do" } },
      },
    },
  ]);
  try {
    const issue = await cloudService(server.url).getIssue("LPB-2");
    assert.match(issue.description, /Users can't log in\./);
    assert.match(issue.description, /Reproduce with any account\./);
  } finally {
    await server.close();
  }
});

test("getIssue: maps assignee, reporter, priority, labels, and dates", async () => {
  const server = await startMockServer([
    {
      status: 200,
      body: {
        key: "LPB-5",
        fields: {
          summary: "Fix login",
          issuetype: { name: "Bug" },
          description: "",
          status: { name: "In Progress" },
          assignee: { displayName: "Asad Ullah" },
          reporter: { displayName: "Jane Doe" },
          priority: { name: "High" },
          labels: ["mobile", "css"],
          created: "2026-07-17T10:00:00.000Z",
          updated: "2026-07-20T08:00:00.000Z",
        },
      },
    },
  ]);
  try {
    const issue = await cloudService(server.url).getIssue("LPB-5");
    assert.equal(issue.assignee, "Asad Ullah");
    assert.equal(issue.reporter, "Jane Doe");
    assert.equal(issue.priority, "High");
    assert.deepEqual(issue.labels, ["mobile", "css"]);
    assert.equal(issue.created, "2026-07-17T10:00:00.000Z");
    assert.equal(issue.updated, "2026-07-20T08:00:00.000Z");
  } finally {
    await server.close();
  }
});

test("getIssue: 404 names the missing ticket", async () => {
  const server = await startMockServer([{ status: 404, body: {} }]);
  try {
    await assert.rejects(() => cloudService(server.url).getIssue("LPB-9"), /LPB-9.*not found/);
  } finally {
    await server.close();
  }
});

// ---- getMyOpenIssues -----------------------------------------------------------

test("getMyOpenIssues: Cloud posts to the v3 JQL endpoint and maps fields", async () => {
  const server = await startMockServer([
    {
      status: 200,
      body: {
        issues: [
          {
            key: "LPB-1",
            fields: {
              summary: "Add login",
              issuetype: { name: "Story" },
              status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
              priority: { name: "High" },
              updated: "2026-07-16T10:00:00.000Z",
            },
          },
        ],
      },
    },
  ]);
  try {
    const result = await cloudService(server.url).getMyOpenIssues(undefined, true);
    assert.equal(server.requests[0].url, "/rest/api/3/search/jql");
    assert.equal(result.sprintFilterApplied, true);
    assert.deepEqual(result.issues, [
      {
        key: "LPB-1",
        summary: "Add login",
        issueType: "Story",
        status: "In Progress",
        statusCategory: "indeterminate",
        priority: "High",
        updated: "2026-07-16T10:00:00.000Z",
      },
    ]);
  } finally {
    await server.close();
  }
});

test("getMyOpenIssues: Server/DC posts to the v2 search endpoint", async () => {
  const server = await startMockServer([{ status: 200, body: { issues: [] } }]);
  try {
    await serverService(server.url).getMyOpenIssues(undefined, false);
    assert.equal(server.requests[0].url, "/rest/api/2/search");
  } finally {
    await server.close();
  }
});

test("getMyOpenIssues: falls back to all-open when the Sprint field/function is unsupported", async () => {
  const server = await startMockServer([
    { status: 400, body: { errorMessages: ["Field 'sprint' does not exist or you do not have permission to view it."] } },
    { status: 200, body: { issues: [] } },
  ]);
  try {
    const result = await cloudService(server.url).getMyOpenIssues(undefined, true);
    assert.equal(result.sprintFilterApplied, false);
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test("getMyOpenIssues: a 400 unrelated to sprints is not silently retried", async () => {
  const server = await startMockServer([
    { status: 400, body: { errorMessages: ["Some other JQL problem."] } },
  ]);
  try {
    await assert.rejects(() => cloudService(server.url).getMyOpenIssues(undefined, true));
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

// ---- transitions ----------------------------------------------------------------

test("transitionTo: applies a matching transition", async () => {
  const server = await startMockServer([
    { status: 200, body: { transitions: [{ id: "21", name: "In Progress", to: { name: "In Progress" } }] } },
    { status: 204, body: "" },
  ]);
  try {
    const result = await cloudService(server.url).transitionTo("LPB-1", "In Progress");
    assert.equal(result.applied, "In Progress");
    assert.equal(server.requests[1].method, "POST");
    assert.match(server.requests[1].body, /"id":"21"/);
  } finally {
    await server.close();
  }
});

test("transitionTo: no matching transition is reported as skipped, not thrown", async () => {
  const server = await startMockServer([
    { status: 200, body: { transitions: [{ id: "1", name: "Done", to: { name: "Done" } }] } },
  ]);
  try {
    const result = await cloudService(server.url).transitionTo("LPB-1", "In Review");
    assert.ok(result.skipped);
    assert.equal(result.applied, undefined);
    assert.equal(server.requests.length, 1); // never POSTed a transition
  } finally {
    await server.close();
  }
});
