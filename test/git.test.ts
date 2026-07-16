import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemoteUrl } from "../src/services/git";

test("parseRemoteUrl: SSH form", () => {
  assert.deepEqual(parseRemoteUrl("git@gitlab.com:group/project.git"), {
    host: "gitlab.com",
    projectPath: "group/project",
  });
});

test("parseRemoteUrl: SSH form without .git", () => {
  assert.deepEqual(parseRemoteUrl("git@gitlab.com:group/project"), {
    host: "gitlab.com",
    projectPath: "group/project",
  });
});

test("parseRemoteUrl: HTTPS with nested subgroups", () => {
  assert.deepEqual(parseRemoteUrl("https://gitlab.com/group/sub/project.git"), {
    host: "gitlab.com",
    projectPath: "group/sub/project",
  });
});

test("parseRemoteUrl: HTTPS with embedded credentials", () => {
  assert.deepEqual(parseRemoteUrl("https://oauth2:token@gitlab.com/group/project.git"), {
    host: "gitlab.com",
    projectPath: "group/project",
  });
});

test("parseRemoteUrl: self-hosted host", () => {
  assert.deepEqual(parseRemoteUrl("git@gitlab.acme.internal:team/repo.git"), {
    host: "gitlab.acme.internal",
    projectPath: "team/repo",
  });
});

test("parseRemoteUrl: garbage returns undefined", () => {
  assert.equal(parseRemoteUrl("not a url"), undefined);
});
