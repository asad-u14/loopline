import { test } from "node:test";
import assert from "node:assert/strict";
import { GitLabService, GitLabError } from "../src/services/gitlab";
import { startMockServer } from "./support/mock-server";

function service(baseUrl: string): GitLabService {
  return new GitLabService(baseUrl, "tok");
}

// ---- constructor / base path ---------------------------------------------------

test("constructor: requests go under /api/v4 with the token header", async () => {
  const server = await startMockServer([{ status: 200, body: { username: "ada" } }]);
  try {
    await service(server.url).verify();
    assert.equal(server.requests[0].url, "/api/v4/user");
    assert.equal(server.requests[0].headers["private-token"], "tok");
  } finally {
    await server.close();
  }
});

// ---- verify() -------------------------------------------------------------------

test("verify: succeeds and returns the username", async () => {
  const server = await startMockServer([{ status: 200, body: { username: "ada" } }]);
  try {
    assert.equal(await service(server.url).verify(), "ada");
  } finally {
    await server.close();
  }
});

test("verify: 401 rejects outright", async () => {
  const server = await startMockServer([{ status: 401, body: {} }]);
  try {
    await assert.rejects(() => service(server.url).verify(), (err: GitLabError) => {
      assert.match(err.message, /rejected your token/);
      assert.equal(err.status, 401);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("verify: 403 on /user falls back to /version and succeeds", async () => {
  const server = await startMockServer([
    { status: 403, body: {} },
    { status: 200, body: { version: "17.1.0" } },
  ]);
  try {
    const result = await service(server.url).verify();
    assert.match(result, /17\.1\.0/);
    assert.match(result, /token OK/);
    assert.equal(server.requests[1].url, "/api/v4/version");
  } finally {
    await server.close();
  }
});

test("verify: 403 then 401 on /version -> the token really is bad", async () => {
  const server = await startMockServer([
    { status: 403, body: {} },
    { status: 401, body: {} },
  ]);
  try {
    await assert.rejects(() => service(server.url).verify(), /rejected your token/);
  } finally {
    await server.close();
  }
});

test("verify: 403 then 403 on /version -> still accepted (MR scope checked later)", async () => {
  const server = await startMockServer([
    { status: 403, body: {} },
    { status: 403, body: {} },
  ]);
  try {
    const result = await service(server.url).verify();
    assert.match(result, /token accepted/);
  } finally {
    await server.close();
  }
});

test("verify: 404 -> host hint", async () => {
  const server = await startMockServer([{ status: 404, body: {} }]);
  try {
    await assert.rejects(() => service(server.url).verify(), /check the GitLab host URL/);
  } finally {
    await server.close();
  }
});

// ---- findOpenMR -------------------------------------------------------------------

test("findOpenMR: returns the first match", async () => {
  const server = await startMockServer([
    { status: 200, body: [{ iid: 42, web_url: "https://gitlab.com/x/-/merge_requests/42" }] },
  ]);
  try {
    const mr = await service(server.url).findOpenMR("group/project", "feature/LPB-1-x");
    assert.equal(mr?.iid, 42);
    assert.match(server.requests[0].url, /state=opened/);
    assert.match(server.requests[0].url, /source_branch=feature%2FLPB-1-x/);
  } finally {
    await server.close();
  }
});

test("findOpenMR: no open MR returns undefined, not an error", async () => {
  const server = await startMockServer([{ status: 200, body: [] }]);
  try {
    assert.equal(await service(server.url).findOpenMR("group/project", "feature/LPB-1-x"), undefined);
  } finally {
    await server.close();
  }
});

test("findOpenMR: a numeric project id is sent as-is (not URL-encoded)", async () => {
  const server = await startMockServer([{ status: 200, body: [] }]);
  try {
    await service(server.url).findOpenMR("1234", "feature/LPB-1-x");
    assert.match(server.requests[0].url, /^\/api\/v4\/projects\/1234\/merge_requests/);
  } finally {
    await server.close();
  }
});

test("findOpenMR: a non-numeric project path is URL-encoded", async () => {
  const server = await startMockServer([{ status: 200, body: [] }]);
  try {
    await service(server.url).findOpenMR("group/sub project", "feature/LPB-1-x");
    assert.match(server.requests[0].url, /^\/api\/v4\/projects\/group%2Fsub%20project\/merge_requests/);
  } finally {
    await server.close();
  }
});

// ---- createMR ---------------------------------------------------------------------

test("createMR: posts the expected body, removing the source branch by default", async () => {
  const server = await startMockServer([
    { status: 201, body: { iid: 7, web_url: "https://gitlab.com/x/-/merge_requests/7" } },
  ]);
  try {
    const mr = await service(server.url).createMR("group/project", {
      sourceBranch: "feature/LPB-1-x",
      targetBranch: "main",
      title: "LPB-1 Add login",
      description: "body",
    });
    assert.equal(mr.iid, 7);
    const body = JSON.parse(server.requests[0].body);
    assert.deepEqual(body, {
      source_branch: "feature/LPB-1-x",
      target_branch: "main",
      title: "LPB-1 Add login",
      description: "body",
      remove_source_branch: true,
    });
  } finally {
    await server.close();
  }
});

test("createMR: draft prefixes the title", async () => {
  const server = await startMockServer([{ status: 201, body: { iid: 8, web_url: "x" } }]);
  try {
    await service(server.url).createMR("group/project", {
      sourceBranch: "feature/LPB-1-x",
      targetBranch: "main",
      title: "LPB-1 Add login",
      description: "body",
      draft: true,
    });
    const body = JSON.parse(server.requests[0].body);
    assert.equal(body.title, "Draft: LPB-1 Add login");
  } finally {
    await server.close();
  }
});

test("createMR: 403 explains the scope/access requirement", async () => {
  const server = await startMockServer([{ status: 403, body: {} }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).createMR("group/project", {
          sourceBranch: "feature/LPB-1-x",
          targetBranch: "main",
          title: "t",
          description: "d",
        }),
      /api.*scope.*Developer access/i
    );
  } finally {
    await server.close();
  }
});

test("createMR: 404 points at the project id setting", async () => {
  const server = await startMockServer([{ status: 404, body: {} }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).createMR("group/project", {
          sourceBranch: "feature/LPB-1-x",
          targetBranch: "main",
          title: "t",
          description: "d",
        }),
      /loopline\.gitlab\.projectId/
    );
  } finally {
    await server.close();
  }
});

test("createMR: an unmapped status surfaces GitLab's own error message", async () => {
  const server = await startMockServer([{ status: 422, body: { message: "Branch already exists" } }]);
  try {
    await assert.rejects(
      () =>
        service(server.url).createMR("group/project", {
          sourceBranch: "feature/LPB-1-x",
          targetBranch: "main",
          title: "t",
          description: "d",
        }),
      /Branch already exists/
    );
  } finally {
    await server.close();
  }
});
