import * as vscode from "vscode";
import { ImpactStats, EMPTY_IMPACT_STATS } from "./impact";

const KEY = "loopline.impactStats";

/** Global (not per-workspace): the whole point is a running personal tally across projects. */
export function getImpactStats(ctx: vscode.ExtensionContext): ImpactStats {
  return ctx.globalState.get<ImpactStats>(KEY) ?? EMPTY_IMPACT_STATS;
}

type CounterField = "branchesCreated" | "commitsPushed" | "mrsOpened";

async function bump(ctx: vscode.ExtensionContext, field: CounterField): Promise<void> {
  const stats = getImpactStats(ctx);
  const next: ImpactStats = { ...stats, since: stats.since ?? new Date().toISOString() };
  next[field] = stats[field] + 1;
  await ctx.globalState.update(KEY, next);
}

export const recordBranchCreated = (ctx: vscode.ExtensionContext): Promise<void> =>
  bump(ctx, "branchesCreated");
export const recordCommitPushed = (ctx: vscode.ExtensionContext): Promise<void> =>
  bump(ctx, "commitsPushed");
export const recordMrOpened = (ctx: vscode.ExtensionContext): Promise<void> => bump(ctx, "mrsOpened");

export async function resetImpactStats(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.globalState.update(KEY, undefined);
}
