import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { createMockContext } from "./support/vscode-test-helpers";
import {
  getImpactStats,
  recordBranchCreated,
  recordCommitPushed,
  recordMrOpened,
  resetImpactStats,
} from "../src/util/impactStore";
import { EMPTY_IMPACT_STATS } from "../src/util/impact";

beforeEach(() => {
  vscode.__resetVscodeMock();
});

test("getImpactStats: returns EMPTY_IMPACT_STATS when nothing recorded yet", () => {
  const ctx = createMockContext();
  assert.deepEqual(getImpactStats(ctx), EMPTY_IMPACT_STATS);
});

test("recordBranchCreated: increments branchesCreated and sets since on first call only", async () => {
  const ctx = createMockContext();
  await recordBranchCreated(ctx);
  const first = getImpactStats(ctx);
  assert.equal(first.branchesCreated, 1);
  assert.equal(first.commitsPushed, 0);
  assert.equal(first.mrsOpened, 0);
  assert.ok(first.since);

  await recordBranchCreated(ctx);
  const second = getImpactStats(ctx);
  assert.equal(second.branchesCreated, 2);
  assert.equal(second.since, first.since, "since must not change on subsequent calls");
});

test("recordCommitPushed: increments commitsPushed", async () => {
  const ctx = createMockContext();
  await recordCommitPushed(ctx);
  const stats = getImpactStats(ctx);
  assert.equal(stats.commitsPushed, 1);
  assert.equal(stats.branchesCreated, 0);
  assert.equal(stats.mrsOpened, 0);
  assert.ok(stats.since);
});

test("recordMrOpened: increments mrsOpened", async () => {
  const ctx = createMockContext();
  await recordMrOpened(ctx);
  const stats = getImpactStats(ctx);
  assert.equal(stats.mrsOpened, 1);
  assert.equal(stats.branchesCreated, 0);
  assert.equal(stats.commitsPushed, 0);
  assert.ok(stats.since);
});

test("resetImpactStats: clears stats back to the default", async () => {
  const ctx = createMockContext();
  await recordBranchCreated(ctx);
  await recordCommitPushed(ctx);
  await recordMrOpened(ctx);
  assert.notDeepEqual(getImpactStats(ctx), EMPTY_IMPACT_STATS);

  await resetImpactStats(ctx);
  assert.deepEqual(getImpactStats(ctx), EMPTY_IMPACT_STATS);
});
