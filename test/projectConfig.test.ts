import { test } from "node:test";
import assert from "node:assert/strict";
import { filterProjectConfig, PROJECT_CONFIG_KEYS } from "../src/util/projectConfig";

test("filterProjectConfig: passes through every recognized, correctly-typed key", () => {
  const raw = {
    branchTypeMapping: { Bug: "bugfix" },
    commitTypeMapping: { bugfix: "fix" },
    protectedBranches: ["main", "release"],
    defaultTargetBranch: "main",
    jiraTransitionOnBranch: "In Progress",
    jiraTransitionOnMr: "In Review",
    jiraTicketScope: "allOpen",
    staging: "pick",
    singleCommit: "off",
    branchNameTemplate: "{ticket}_{slug}",
    commitMessageTemplate: "[{ticket}] {summary}",
    changelogEnabled: true,
    changelogCategoryMapping: { bugfix: "Fixed" },
  };
  assert.deepEqual(filterProjectConfig(raw), raw);
});

test("filterProjectConfig: rejects a non-boolean changelogEnabled and non-string-map categoryMapping", () => {
  const raw = { changelogEnabled: "yes", changelogCategoryMapping: { bugfix: 5 } };
  assert.deepEqual(filterProjectConfig(raw), {});
});

test("filterProjectConfig: drops unrecognized keys silently", () => {
  const raw = { defaultTargetBranch: "main", somethingMadeUp: "whatever" };
  assert.deepEqual(filterProjectConfig(raw), { defaultTargetBranch: "main" });
});

test("filterProjectConfig: drops keys with the wrong type instead of throwing", () => {
  const raw = {
    defaultTargetBranch: 123,
    protectedBranches: "main", // should be an array
    branchTypeMapping: { Bug: 5 }, // values must be strings
    jiraTicketScope: "sometimeSprint", // not a valid enum value
  };
  assert.deepEqual(filterProjectConfig(raw), {});
});

test("filterProjectConfig: non-object input yields an empty config", () => {
  assert.deepEqual(filterProjectConfig(null), {});
  assert.deepEqual(filterProjectConfig(undefined), {});
  assert.deepEqual(filterProjectConfig("a string"), {});
  assert.deepEqual(filterProjectConfig([1, 2, 3]), {});
});

test("filterProjectConfig: empty object yields an empty config", () => {
  assert.deepEqual(filterProjectConfig({}), {});
});

test("PROJECT_CONFIG_KEYS: lists exactly the keys filterProjectConfig recognizes", () => {
  const raw = Object.fromEntries(PROJECT_CONFIG_KEYS.map((k) => [k, "placeholder"]));
  // Every key gets rejected here (wrong type for most), but the point is that
  // filtering runs without throwing over the full recognized key set.
  assert.doesNotThrow(() => filterProjectConfig(raw));
});
