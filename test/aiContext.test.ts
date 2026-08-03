import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { syncTicketContextToClaudeMd, CLAUDE_MD_FILENAME } from "../src/util/aiContext";

const dirs: string[] = [];

function mkTmpDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loopline-aicontext-")));
  dirs.push(d);
  return d;
}

after(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

test("syncTicketContextToClaudeMd: creates CLAUDE.md with a delimited block when none exists", () => {
  const repo = mkTmpDir();
  const { filePath } = syncTicketContextToClaudeMd(repo, "# Jira Ticket LPB-1: Do the thing\n");
  assert.equal(filePath, path.join(repo, CLAUDE_MD_FILENAME));
  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /<!-- loopline:ticket-context:start -->/);
  assert.match(content, /<!-- loopline:ticket-context:end -->/);
  assert.match(content, /Jira Ticket LPB-1: Do the thing/);
});

test("syncTicketContextToClaudeMd: appends the block below existing hand-written content", () => {
  const repo = mkTmpDir();
  const filePath = path.join(repo, CLAUDE_MD_FILENAME);
  fs.writeFileSync(filePath, "# Project notes\n\nSome conventions here.\n", "utf8");

  syncTicketContextToClaudeMd(repo, "# Jira Ticket LPB-2: Fix the bug\n");
  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /# Project notes/);
  assert.match(content, /Some conventions here\./);
  assert.match(content, /Jira Ticket LPB-2: Fix the bug/);
});

test("syncTicketContextToClaudeMd: re-syncing replaces the previous block in place, keeps other content untouched", () => {
  const repo = mkTmpDir();
  const filePath = path.join(repo, CLAUDE_MD_FILENAME);
  fs.writeFileSync(filePath, "# Project notes\n\nSome conventions here.\n", "utf8");

  syncTicketContextToClaudeMd(repo, "# Jira Ticket LPB-3: First ticket\n");
  syncTicketContextToClaudeMd(repo, "# Jira Ticket LPB-4: Second ticket\n");

  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /# Project notes/);
  assert.match(content, /Some conventions here\./);
  assert.doesNotMatch(content, /LPB-3/);
  assert.match(content, /Jira Ticket LPB-4: Second ticket/);
  // Exactly one pair of markers — no duplicate blocks left behind.
  assert.equal(content.match(/<!-- loopline:ticket-context:start -->/g)?.length, 1);
  assert.equal(content.match(/<!-- loopline:ticket-context:end -->/g)?.length, 1);
});
