import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ImpactStats,
  ImpactRates,
  hasAnyActivity,
  estimateMinutesSaved,
  formatDuration,
  formatImpactLine,
  formatSinceDate,
  formatImpactTooltip,
  formatImpactDetail,
} from "../src/util/impact";

const rates: ImpactRates = { minutesPerBranch: 15, minutesPerCommit: 5, minutesPerMr: 10 };

test("hasAnyActivity: false when everything is zero", () => {
  assert.equal(hasAnyActivity({ branchesCreated: 0, commitsPushed: 0, mrsOpened: 0 }), false);
});

test("hasAnyActivity: true as soon as one counter is nonzero", () => {
  assert.equal(hasAnyActivity({ branchesCreated: 1, commitsPushed: 0, mrsOpened: 0 }), true);
  assert.equal(hasAnyActivity({ branchesCreated: 0, commitsPushed: 0, mrsOpened: 1 }), true);
});

test("estimateMinutesSaved: sums each counter against its rate", () => {
  const stats: ImpactStats = { branchesCreated: 2, commitsPushed: 3, mrsOpened: 1 };
  // 2*15 + 3*5 + 1*10 = 55
  assert.equal(estimateMinutesSaved(stats, rates), 55);
});

test("formatDuration: under an hour is compact minutes", () => {
  assert.equal(formatDuration(45), "45m");
  assert.equal(formatDuration(0), "0m");
});

test("formatDuration: an hour or more is hours, no trailing .0", () => {
  assert.equal(formatDuration(60), "1h");
  assert.equal(formatDuration(120), "2h");
  assert.equal(formatDuration(210), "3.5h");
});

test("formatImpactLine: singular vs plural counts", () => {
  const one: ImpactStats = { branchesCreated: 1, commitsPushed: 1, mrsOpened: 1 };
  assert.equal(formatImpactLine(one, rates), "1 branch · 1 commit · 1 MR · ~30m saved");

  const many: ImpactStats = { branchesCreated: 12, commitsPushed: 8, mrsOpened: 5 };
  // 12*15 + 8*5 + 5*10 = 180+40+50 = 270 -> 4.5h
  assert.equal(formatImpactLine(many, rates), "12 branches · 8 commits · 5 MRs · ~4.5h saved");
});

test("formatSinceDate: formats a valid ISO date and falls back on garbage", () => {
  assert.match(formatSinceDate(new Date("2026-06-01T00:00:00Z").toISOString()), /2026/);
  assert.equal(formatSinceDate("not-a-date"), "not-a-date");
});

test("formatImpactTooltip: includes counts, estimate, and the since date when present", () => {
  const stats: ImpactStats = {
    branchesCreated: 12,
    commitsPushed: 8,
    mrsOpened: 5,
    since: new Date("2026-06-01T00:00:00Z").toISOString(),
  };
  const tooltip = formatImpactTooltip(stats, rates);
  assert.match(tooltip, /since Jun 1, 2026/);
  assert.match(tooltip, /Branches created: 12/);
  assert.match(tooltip, /~4.5h/);
  assert.match(tooltip, /15m\/branch/);
});

test("formatImpactTooltip: omits the since clause when there's no date yet", () => {
  const stats: ImpactStats = { branchesCreated: 1, commitsPushed: 0, mrsOpened: 0 };
  assert.doesNotMatch(formatImpactTooltip(stats, rates), /since/i);
});

test("formatImpactDetail: same facts as the tooltip, without the click-to-open footer", () => {
  const stats: ImpactStats = {
    branchesCreated: 1,
    commitsPushed: 0,
    mrsOpened: 0,
    since: new Date("2026-06-01T00:00:00Z").toISOString(),
  };
  const detail = formatImpactDetail(stats, rates);
  assert.match(detail, /Since Jun 1, 2026/);
  assert.doesNotMatch(detail, /Click for/);
});
