import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changelogCategoryForPrefix,
  buildChangelogLine,
  insertChangelogEntry,
  DEFAULT_CHANGELOG_CATEGORY_MAPPING,
} from "../src/util/changelog";

test("changelogCategoryForPrefix: maps known prefixes", () => {
  assert.equal(changelogCategoryForPrefix("bugfix", DEFAULT_CHANGELOG_CATEGORY_MAPPING), "Fixed");
  assert.equal(changelogCategoryForPrefix("feature", DEFAULT_CHANGELOG_CATEGORY_MAPPING), "Added");
  assert.equal(changelogCategoryForPrefix("hotfix", DEFAULT_CHANGELOG_CATEGORY_MAPPING), "Fixed");
  assert.equal(changelogCategoryForPrefix("chore", DEFAULT_CHANGELOG_CATEGORY_MAPPING), "Changed");
});

test("changelogCategoryForPrefix: unmapped prefix defaults to Changed", () => {
  assert.equal(changelogCategoryForPrefix("spike", DEFAULT_CHANGELOG_CATEGORY_MAPPING), "Changed");
});

test("buildChangelogLine: links the ticket when a Jira base URL is set", () => {
  assert.equal(
    buildChangelogLine("LPB-1234", "Fix login redirect", "https://acme.atlassian.net"),
    "- **[LPB-1234](https://acme.atlassian.net/browse/LPB-1234)** — Fix login redirect"
  );
});

test("buildChangelogLine: falls back to a bare key without a base URL", () => {
  assert.equal(buildChangelogLine("LPB-1234", "Fix login redirect", ""), "- **LPB-1234** — Fix login redirect");
});

test("buildChangelogLine: normalizes internal whitespace", () => {
  assert.equal(
    buildChangelogLine("LPB-1", "  too   many   spaces  ", ""),
    "- **LPB-1** — too many spaces"
  );
});

test("insertChangelogEntry: creates an Unreleased section when none exists", () => {
  const content = [
    "# Changelog",
    "",
    "All notable changes are documented here.",
    "",
    "## [0.21.1] — 2026-07-17",
    "### Fixed",
    "- Something",
  ].join("\n");

  const result = insertChangelogEntry(content, "Added", "- **LPB-1** — Add login");
  const lines = result.split("\n");

  assert.equal(lines[4], "## Unreleased");
  assert.equal(lines[5], ""); // blank line after the new heading
  assert.equal(lines[6], "### Added");
  assert.equal(lines[7], "- **LPB-1** — Add login");
  // The pre-existing versioned section is untouched, just pushed down.
  assert.ok(result.includes("## [0.21.1] — 2026-07-17"));
  assert.ok(result.includes("### Fixed\n- Something"));
});

test("insertChangelogEntry: adds a new bullet to an existing subsection, after the last one", () => {
  const content = [
    "# Changelog",
    "",
    "## Unreleased",
    "### Added",
    "- **LPB-1** — First thing",
    "",
    "## [0.21.1] — 2026-07-17",
    "### Fixed",
    "- Old fix",
  ].join("\n");

  const result = insertChangelogEntry(content, "Added", "- **LPB-2** — Second thing");
  const lines = result.split("\n");

  assert.deepEqual(
    lines.slice(2, 6),
    ["## Unreleased", "### Added", "- **LPB-1** — First thing", "- **LPB-2** — Second thing"]
  );
});

test("insertChangelogEntry: with two existing subsections, a bullet lands at the end of the FIRST one, not the second", () => {
  const content = [
    "# Changelog",
    "",
    "## Unreleased",
    "### Added",
    "- **LPB-1** — First thing",
    "### Fixed",
    "- **LPB-3** — A fix",
    "",
    "## [0.21.1] — 2026-07-17",
    "### Fixed",
    "- Old fix",
  ].join("\n");

  const result = insertChangelogEntry(content, "Added", "- **LPB-2** — Second thing");
  const lines = result.split("\n");

  assert.deepEqual(
    lines.slice(2, 7),
    ["## Unreleased", "### Added", "- **LPB-1** — First thing", "- **LPB-2** — Second thing", "### Fixed"]
  );
});

test("insertChangelogEntry: adds a new subsection under an existing Unreleased heading", () => {
  const content = ["# Changelog", "", "## Unreleased", "### Added", "- **LPB-1** — Add login", ""].join("\n");

  const result = insertChangelogEntry(content, "Fixed", "- **LPB-2** — Fix redirect");
  assert.ok(result.includes("### Fixed\n- **LPB-2** — Fix redirect"));
  // Original section is preserved.
  assert.ok(result.includes("### Added\n- **LPB-1** — Add login"));
});

test("insertChangelogEntry: an empty/blank file still gets a well-formed Unreleased block", () => {
  const result = insertChangelogEntry("", "Added", "- **LPB-1** — Add login");
  assert.ok(result.includes("## Unreleased"));
  assert.ok(result.includes("### Added"));
  assert.ok(result.includes("- **LPB-1** — Add login"));
});

test("insertChangelogEntry: recognizes a bracketed Unreleased heading too", () => {
  const content = ["# Changelog", "", "## [Unreleased]", "### Added", "- old"].join("\n");
  const result = insertChangelogEntry(content, "Added", "- new");
  assert.deepEqual(result.split("\n").slice(2, 5), ["## [Unreleased]", "### Added", "- old"]);
  assert.ok(result.endsWith("- new"));
});
