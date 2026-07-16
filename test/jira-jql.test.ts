import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMyIssuesJql } from "../src/util/jira-jql";

test("buildMyIssuesJql: active sprint includes openSprints()", () => {
  const jql = buildMyIssuesJql(true);
  assert.match(jql, /assignee = currentUser\(\)/);
  assert.match(jql, /sprint in openSprints\(\)/);
  assert.match(jql, /resolution = Unresolved/);
  assert.match(jql, /ORDER BY updated DESC$/);
});

test("buildMyIssuesJql: all-open omits the sprint clause", () => {
  const jql = buildMyIssuesJql(false);
  assert.doesNotMatch(jql, /sprint/);
  assert.match(jql, /assignee = currentUser\(\) AND resolution = Unresolved ORDER BY updated DESC/);
});
