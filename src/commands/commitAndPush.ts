import * as vscode from "vscode";
import { GitService, RepoStatus } from "../services/git";
import { readConfigForRepo, ensureConfigured, LooplineConfig } from "../util/config";
import {
  parseBranchName,
  extractTicketKey,
  buildCommitMessage,
} from "../util/text";
import { parseTicketCheckVerdict } from "../util/ai-prompt";
import { recordCommitPushed, recordMrOpened } from "../util/impactStore";
import { changelogCategoryForPrefix, buildChangelogLine, insertChangelogEntry } from "../util/changelog";
import * as fs from "fs";
import * as path from "path";
import {
  resolveRepoRoot,
  buildJiraService,
  buildGitLabService,
  resolveGitLabProject,
  buildAiService,
  tryTransitionTicket,
} from "../util/workspace";
import { withCancellableProgress, isCancelled } from "../util/progress";
import { log, logError } from "../util/log";
import {
  StagingPlan,
  StagingMode,
  planRespectStaged,
  pickCandidates,
  isCleanTree,
  partiallyStagedFiles,
} from "../util/staging";

export async function commitAndPushCommand(ctx: vscode.ExtensionContext): Promise<void> {
  if (!(await ensureConfigured(ctx))) {
    return;
  }

  const repoRoot = await resolveRepoRoot(ctx);
  if (!repoRoot) {
    return;
  }
  const git = new GitService(repoRoot);
  if (!(await git.isRepo())) {
    vscode.window.showErrorMessage("Loopline: this folder isn't a git repository.");
    return;
  }

  // Pre-flight guard: detached HEAD — you can't push a branch you're not on.
  if (await git.isDetachedHead()) {
    vscode.window.showErrorMessage(
      "Loopline: HEAD is detached. Check out a branch before committing."
    );
    return;
  }

  // Pre-flight guard: an origin remote is required to push / open an MR.
  if (!(await git.hasRemote("origin"))) {
    vscode.window.showErrorMessage(
      "Loopline: no 'origin' remote found. Add one with `git remote add origin <url>`."
    );
    return;
  }

  const cfg = readConfigForRepo(repoRoot);
  const branch = await git.currentBranch();

  // Pre-flight guard: don't commit directly onto a protected branch.
  if (cfg.protectedBranches.map((b) => b.toLowerCase()).includes(branch.toLowerCase())) {
    const go = await vscode.window.showWarningMessage(
      `"${branch}" is a protected branch. Committing here is usually a mistake — continue anyway?`,
      "Commit here anyway",
      "Cancel"
    );
    if (go !== "Commit here anyway") {
      return;
    }
  }

  // 1. Recover ticket + prefix from the branch name; fall back to asking.
  let ticketKey: string;
  let branchPrefix: string;

  const parsed = parseBranchName(branch);
  if (parsed) {
    ticketKey = parsed.ticket;
    branchPrefix = parsed.prefix;
  } else {
    const raw = await vscode.window.showInputBox({
      title: "Loopline: Ticket for this commit",
      prompt: `Branch "${branch}" doesn't match the convention — enter the ticket key.`,
      ignoreFocusOut: true,
      validateInput: (v) => (extractTicketKey(v) ? undefined : "Expected a key like ABC-123."),
    });
    if (!raw) {
      return;
    }
    ticketKey = extractTicketKey(raw)!.key;

    const prefixPick = await vscode.window.showQuickPick(
      Object.keys(cfg.commitTypeMapping).length
        ? Object.keys(cfg.commitTypeMapping)
        : ["feature", "bugfix"],
      { title: "Loopline: branch/commit type", ignoreFocusOut: true }
    );
    if (!prefixPick) {
      return;
    }
    branchPrefix = prefixPick;
  }

  // Fetch Jira ticket details when either the MR-description-include flag or AI is
  // on, so both the pre-commit ticket check and the MR description can use it.
  let jiraDescription = "";
  let jiraSummary = "";
  if (cfg.includeJiraDescription || cfg.aiEnabled) {
    const jira = await buildJiraService(ctx);
    if (jira) {
      try {
        const issue = await withCancellableProgress("Loopline: fetching ticket details…", (signal) =>
          jira.getIssue(ticketKey, signal)
        );
        jiraSummary = issue.summary;
        jiraDescription = issue.description;
      } catch {
        /* non-fatal (including cancel) */
      }
    }
  }

  // 2. Work out exactly what will be committed. Staging is the developer's
  //     statement of intent, so we honor it rather than sweeping up the repo.
  const status = await git.getStatus();
  if (isCleanTree(status)) {
    vscode.window.showInformationMessage("Loopline: nothing to commit — working tree is clean.");
    return;
  }
  const plan = await resolveStagingPlan(status, cfg.staging);
  if (!plan || plan.kind === "nothing") {
    if (plan?.kind === "nothing") {
      vscode.window.showInformationMessage("Loopline: nothing selected to commit.");
    }
    return;
  }

  // 3. Commit summary.
  const summary = await vscode.window.showInputBox({
    title: `Loopline: Commit summary — ${describePlan(plan)}`,
    prompt: `Will become: <${mapCommitPrefix(cfg.commitTypeMapping, branchPrefix)}>: ${ticketKey} <summary>`,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Summary can't be empty."),
  });
  if (!summary) {
    return;
  }

  const commitPrefix = mapCommitPrefix(cfg.commitTypeMapping, branchPrefix);
  const message = buildCommitMessage(commitPrefix, ticketKey, summary, cfg.commitMessageTemplate);

  // 4. Ask about the MR up front.
  const createMr = await vscode.window.showQuickPick(
    [
      { label: "Commit, push & create MR", value: "mr" },
      { label: "Commit & push only", value: "push" },
    ],
    { title: "Loopline: what next?", ignoreFocusOut: true }
  );
  if (!createMr) {
    return;
  }

  // 5. Decide whether to squash the branch into a single commit. Asked BEFORE we
  //     touch anything, because it rewrites history and force-pushes.
  const squash = await resolveSquash(git, cfg, branch);
  if (squash === undefined) {
    return; // cancelled
  }

  // 6. Stage now, so a pre-commit ticket check (if enabled) sees exactly what's
  //    about to be committed. Read from the INDEX, not the working tree.
  let changedFiles: string[] = [];
  let preCommitDiff = "";
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Loopline: staging…", cancellable: false },
      async () => {
        await applyStagingPlan(git, plan);

        if (!(await git.hasStagedChanges()) && !squash.squashing) {
          throw new Error("nothing ended up staged — aborting before commit.");
        }

        if (squash.squashing && squash.mergeBase) {
          // Collapse existing branch commits + newly staged work into one commit.
          // --soft keeps the index, so unstaged work stays untouched.
          await git.softResetTo(squash.mergeBase);
        }

        // Read from the index: this is exactly what the commit will contain.
        changedFiles = await git.listStagedFiles();
        preCommitDiff = cfg.aiEnabled ? await git.getStagedDiff() : "";
      }
    );
  } catch (err) {
    logError("staging failed", err);
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
    return;
  }

  // 7. Optional, opt-in (`loopline.ai.checkDiffAgainstTicket`): before committing,
  //    ask the AI whether the diff addresses the ticket. Purely advisory — any
  //    failure or a "looks complete" verdict falls through silently; only a
  //    POSSIBLE GAPS verdict pauses, and the user always has the final call.
  if (cfg.aiEnabled && cfg.aiCheckDiffAgainstTicket && preCommitDiff.trim()) {
    const proceed = await confirmDiffMatchesTicket(
      ctx,
      ticketKey,
      jiraSummary || summary,
      jiraDescription,
      preCommitDiff
    );
    if (!proceed) {
      vscode.window.showInformationMessage("Loopline: commit cancelled — staged changes are untouched.");
      return;
    }
  }

  // 8. Commit + push.
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Loopline: commit & push…", cancellable: false },
      async (progress) => {
        progress.report({ message: "committing" });
        await git.commit(message, cfg.gitCommitExtraArgs);

        progress.report({ message: "pushing" });
        if (squash.needsForce) {
          await git.pushForceWithLease(branch, cfg.gitPushExtraArgs);
        } else {
          await git.pushSetUpstream(branch, cfg.gitPushExtraArgs);
        }
      }
    );
  } catch (err) {
    logError("commit/push failed", err);
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
    return;
  }
  log(
    `committed ${changedFiles.length} file(s)${squash.squashing ? ` (squashed ${squash.existing} commit(s))` : ""}`
  );
  await recordCommitPushed(ctx);

  if (createMr.value !== "mr") {
    vscode.window.showInformationMessage(`Loopline: pushed "${message}".`);
    await vscode.commands.executeCommand("loopline.refreshTicketStatus");
    return;
  }

  // 9. Create (or find existing) MR.
  const gitlab = await buildGitLabService(ctx);
  if (!gitlab) {
    vscode.window.showErrorMessage("Loopline: GitLab isn't configured. Run setup.");
    return;
  }
  const project = await resolveGitLabProject(git);
  if (!project) {
    vscode.window.showErrorMessage(
      "Loopline: couldn't determine the GitLab project. Set `loopline.gitlab.projectId`."
    );
    return;
  }

  const fallbackDescription = buildMrDescription(
    ticketKey,
    cfg.jiraBaseUrl,
    cfg.includeJiraDescription ? jiraDescription : "",
    changedFiles
  );
  const description = await resolveMrDescription(ctx, {
    cfg,
    git,
    ticketKey,
    summary,
    sourceBranch: branch,
    changedFiles,
    preCommitDiff,
    jiraSummary: jiraSummary || summary,
    jiraDescription,
    fallbackDescription,
  });
  if (description === undefined) {
    vscode.window.showInformationMessage("Loopline: MR cancelled (commit & push already done).");
    return;
  }

  try {
    const existing = await withCancellableProgress("Loopline: checking for an existing MR…", (signal) =>
      gitlab.findOpenMR(project, branch, signal)
    );
    if (existing) {
      const open = await vscode.window.showInformationMessage(
        `Loopline: an open MR already exists (!${existing.iid}).`,
        "Open MR"
      );
      if (open === "Open MR") {
        vscode.env.openExternal(vscode.Uri.parse(existing.web_url));
      }
      return;
    }

    const mr = await withCancellableProgress("Loopline: creating MR…", (signal) =>
      gitlab.createMR(
        project,
        {
          sourceBranch: branch,
          targetBranch: cfg.defaultTargetBranch,
          title: `${ticketKey} ${summary.trim()}`,
          description,
          removeSourceBranch: true,
        },
        signal
      )
    );

    await recordMrOpened(ctx);

    const open = await vscode.window.showInformationMessage(
      `Loopline: created MR !${mr.iid}.`,
      "Open MR"
    );
    if (open === "Open MR") {
      vscode.env.openExternal(vscode.Uri.parse(mr.web_url));
    }

    // Optional: auto-draft a CHANGELOG.md entry and push it onto the MR's branch.
    if (cfg.changelogEnabled) {
      await maybeUpdateChangelog(git, repoRoot, branch, {
        ticketKey,
        summary,
        branchPrefix,
        jiraBaseUrl: cfg.jiraBaseUrl,
        categoryMapping: cfg.changelogCategoryMapping,
        commitExtraArgs: cfg.gitCommitExtraArgs,
        pushExtraArgs: cfg.gitPushExtraArgs,
      });
    }

    // Optional: move the ticket to review (e.g. "In Review").
    if (cfg.jiraTransitionOnMr) {
      await tryTransitionTicket(ctx, ticketKey, cfg.jiraTransitionOnMr);
    }
    await vscode.commands.executeCommand("loopline.refreshTicketStatus");
  } catch (err) {
    if (isCancelled(err)) {
      vscode.window.showInformationMessage("Loopline: MR step cancelled (commit & push already done).");
      return;
    }
    vscode.window.showErrorMessage(`Loopline: ${(err as Error).message}`);
  }
}

/**
 * Ask the AI whether the diff addresses what the ticket asks for. Non-blocking on
 * any failure (disabled, no key, API error, or cancelling the check itself) — only
 * a POSSIBLE GAPS verdict pauses to ask, and the user always has the final call.
 */
async function confirmDiffMatchesTicket(
  ctx: vscode.ExtensionContext,
  ticketKey: string,
  ticketSummary: string,
  ticketDescription: string,
  diff: string
): Promise<boolean> {
  const anthropic = await buildAiService(ctx);
  if (!anthropic) {
    return true;
  }

  let response: string;
  try {
    response = await withCancellableProgress("Loopline: checking diff against ticket…", (signal) =>
      anthropic.checkDiffAgainstTicket({ ticketKey, ticketSummary, ticketDescription, diff }, signal)
    );
  } catch (err) {
    if (!isCancelled(err)) {
      log(`ticket-diff check failed, continuing without it: ${(err as Error).message}`);
    }
    return true;
  }

  const { looksComplete, detail } = parseTicketCheckVerdict(response);
  if (looksComplete) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    `Loopline: the diff may not fully address ${ticketKey}.`,
    { modal: true, detail },
    "Commit anyway",
    "Cancel"
  );
  return choice === "Commit anyway";
}

function mapCommitPrefix(mapping: Record<string, string>, branchPrefix: string): string {
  return mapping[branchPrefix] || branchPrefix;
}

interface ChangelogUpdateInput {
  ticketKey: string;
  summary: string;
  branchPrefix: string;
  jiraBaseUrl: string;
  categoryMapping: Record<string, string>;
  commitExtraArgs: string[];
  pushExtraArgs: string[];
}

/**
 * Auto-draft a CHANGELOG.md entry and push it onto the branch the MR was just
 * opened from, so it actually lands on the MR rather than sitting as a local,
 * uncommitted diff. Never creates CHANGELOG.md — only updates one that already
 * exists. Failures here are logged and surfaced as a warning, never fatal: the
 * MR itself is already created and shouldn't be reported as failed over this.
 */
async function maybeUpdateChangelog(
  git: GitService,
  repoRoot: string,
  branch: string,
  input: ChangelogUpdateInput
): Promise<void> {
  const filePath = path.join(repoRoot, "CHANGELOG.md");
  if (!fs.existsSync(filePath)) {
    log("changelog: no CHANGELOG.md at repo root — skipping");
    return;
  }
  try {
    const category = changelogCategoryForPrefix(input.branchPrefix, input.categoryMapping);
    const line = buildChangelogLine(input.ticketKey, input.summary, input.jiraBaseUrl);
    const current = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(filePath, insertChangelogEntry(current, category, line), "utf8");

    await git.stageFiles(["CHANGELOG.md"]);
    await git.commit(`docs: changelog entry for ${input.ticketKey}`, input.commitExtraArgs);
    await git.pushSetUpstream(branch, input.pushExtraArgs);
    log(`changelog: added a ${category} entry for ${input.ticketKey} and pushed it`);
  } catch (err) {
    logError("changelog update failed", err);
    vscode.window.showWarningMessage(
      `Loopline: MR created, but the changelog entry failed (${(err as Error).message}).`
    );
  }
}

function buildMrDescription(
  ticketKey: string,
  jiraBaseUrl: string,
  jiraDescription: string,
  changedFiles: string[]
): string {
  const lines: string[] = [];
  if (jiraBaseUrl) {
    lines.push(`**Jira:** [${ticketKey}](${jiraBaseUrl}/browse/${ticketKey})`, "");
  } else {
    lines.push(`**Jira:** ${ticketKey}`, "");
  }
  if (jiraDescription.trim()) {
    lines.push("## Ticket description", jiraDescription.trim(), "");
  }
  lines.push("## Changed files");
  if (changedFiles.length) {
    changedFiles.forEach((f) => lines.push(`- \`${f}\``));
  } else {
    lines.push("_(none detected)_");
  }
  lines.push("", "---", "_Generated by Loopline._");
  return lines.join("\n");
}

interface DescriptionInput {
  cfg: LooplineConfig;
  git: GitService;
  ticketKey: string;
  summary: string;
  sourceBranch: string;
  changedFiles: string[];
  preCommitDiff: string;
  jiraSummary: string;
  jiraDescription: string;
  fallbackDescription: string;
}

/**
 * Produce the MR body. When AI is enabled, generate a description from the diff +
 * ticket, open it in an editor for review/edit, and use the edited text. On any
 * problem (disabled, no key, empty diff, API error, user declines), fall back to
 * the deterministic changed-files description.
 */
async function resolveMrDescription(
  ctx: vscode.ExtensionContext,
  input: DescriptionInput
): Promise<string | undefined> {
  const anthropic = await buildAiService(ctx);
  if (!anthropic) {
    return input.fallbackDescription;
  }

  // Prefer the accurate branch diff; fall back to the pre-commit diff we captured.
  let diff = "";
  try {
    diff = await input.git.getBranchDiff(input.cfg.defaultTargetBranch);
  } catch {
    /* ignore */
  }
  if (!diff.trim()) {
    diff = input.preCommitDiff;
  }
  if (!diff.trim()) {
    return input.fallbackDescription; // nothing to describe
  }

  let aiText: string;
  try {
    aiText = await withCancellableProgress("Loopline: generating MR description with AI…", (signal) =>
      anthropic.generateMrDescription(
        {
          ticketKey: input.ticketKey,
          ticketSummary: input.jiraSummary,
          ticketDescription: input.jiraDescription,
          sourceBranch: input.sourceBranch,
          targetBranch: input.cfg.defaultTargetBranch,
          changedFiles: input.changedFiles,
          diff,
        },
        signal
      )
    );
  } catch (err) {
    if (isCancelled(err)) {
      return input.fallbackDescription;
    }
    vscode.window.showWarningMessage(
      `Loopline: AI description failed (${(err as Error).message}). Using the file list instead.`
    );
    return input.fallbackDescription;
  }

  // Add the Jira link footer the deterministic body would have had.
  const jiraFooter = input.cfg.jiraBaseUrl
    ? `\n\n---\n**Jira:** [${input.ticketKey}](${input.cfg.jiraBaseUrl}/browse/${input.ticketKey})`
    : `\n\n---\n**Jira:** ${input.ticketKey}`;
  const proposed = `${aiText}${jiraFooter}`;

  // Review/edit step: open the draft in an editor, let the user edit, then confirm.
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: proposed });
  const editor = await vscode.window.showTextDocument(doc, { preview: true });

  const choice = await vscode.window.showInformationMessage(
    "Loopline: review the AI-generated MR description (edit if needed), then choose.",
    "Use this",
    "Use file list instead",
    "Cancel MR"
  );

  const finalText = doc.getText();
  // Close the scratch editor.
  try {
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  } catch {
    /* ignore */
  }
  void editor;

  if (choice === "Use file list instead") {
    return input.fallbackDescription;
  }
  if (choice === "Use this") {
    return finalText.trim() || input.fallbackDescription;
  }
  // "Cancel MR" or dismissed.
  return undefined;
}

// ---- staging ---------------------------------------------------------------

/** Human summary of what's about to be committed, shown in the summary prompt. */
function describePlan(plan: StagingPlan): string {
  switch (plan.kind) {
    case "index":
      return `${plan.files.length} staged file(s)`;
    case "files":
      return `${plan.files.length} file(s)`;
    case "all":
      return "all changes";
    default:
      return "nothing";
  }
}

/**
 * Turn the working-tree status into a concrete plan, prompting only where a
 * decision genuinely belongs to the user (untracked files, or "pick" mode).
 * Returns undefined if the user cancelled.
 */
async function resolveStagingPlan(
  status: RepoStatus,
  mode: StagingMode
): Promise<StagingPlan | undefined> {
  if (mode === "all") {
    return { kind: "all" };
  }

  if (mode === "pick") {
    const { all, preselected } = pickCandidates(status);
    const picked = await vscode.window.showQuickPick(
      all.map((f) => ({
        label: f,
        description: status.untracked.includes(f)
          ? "untracked"
          : status.staged.includes(f)
            ? "staged"
            : "modified",
        picked: preselected.includes(f),
      })),
      {
        title: "Loopline: choose files to commit",
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    if (!picked) {
      return undefined;
    }
    return picked.length ? { kind: "files", files: picked.map((p) => p.label) } : { kind: "nothing" };
  }

  // respectStaged
  if (status.staged.length > 0) {
    const partial = partiallyStagedFiles(status);
    if (partial.length > 0) {
      // Surfacing this matters: these files have work deliberately left unstaged.
      log(`respecting partial staging in: ${partial.join(", ")}`);
    }
    return planRespectStaged(status, false);
  }

  // Nothing staged: never sweep in untracked files silently.
  let includeUntracked = false;
  if (status.untracked.length > 0) {
    const hasTracked = status.unstaged.length > 0;
    const choice = await vscode.window.showQuickPick(
      [
        ...(hasTracked
          ? [{ label: `Tracked changes only (${status.unstaged.length})`, value: "tracked" }]
          : []),
        {
          label: `Include ${status.untracked.length} untracked file(s)`,
          detail: status.untracked.slice(0, 5).join(", ") + (status.untracked.length > 5 ? "…" : ""),
          value: "include",
        },
        { label: "Choose files…", value: "pick" },
      ],
      {
        title: `Loopline: ${status.untracked.length} untracked file(s) present`,
        placeHolder: "Untracked files are never committed without asking",
        ignoreFocusOut: true,
      }
    );
    if (!choice) {
      return undefined;
    }
    if (choice.value === "pick") {
      return resolveStagingPlan(status, "pick");
    }
    includeUntracked = choice.value === "include";
  }
  return planRespectStaged(status, includeUntracked);
}

async function applyStagingPlan(git: GitService, plan: StagingPlan): Promise<void> {
  switch (plan.kind) {
    case "index":
      // Already staged — deliberately do nothing, so hunk-level staging survives.
      return;
    case "files":
      // Start from a clean index so unpicked files can't ride along.
      await git.unstageAll();
      await git.stageFiles(plan.files);
      return;
    case "all":
      await git.stageAll();
      return;
    default:
      return;
  }
}

// ---- single-commit / squash ------------------------------------------------

interface SquashDecision {
  squashing: boolean;
  needsForce: boolean;
  mergeBase?: string;
  existing: number;
}

/**
 * Keep the MR at one commit. The first commit on a branch needs nothing; once the
 * branch already has commits, we offer to collapse them — which rewrites history,
 * so it's always an explicit choice.
 */
async function resolveSquash(
  git: GitService,
  cfg: LooplineConfig,
  branch: string
): Promise<SquashDecision | undefined> {
  const none: SquashDecision = { squashing: false, needsForce: false, existing: 0 };
  if (cfg.singleCommit === "off") {
    return none;
  }

  const base = cfg.baseBranch || cfg.defaultTargetBranch;
  const mergeBase = await git.mergeBaseWith(base);
  if (!mergeBase) {
    log(`squash: couldn't resolve a merge-base with "${base}" — committing normally`);
    return none;
  }
  const existing = await git.countCommitsSince(mergeBase);
  if (existing === 0) {
    return none; // first commit on the branch: already a single commit
  }

  const pushed = await git.hasUpstream(branch);
  const subjects = await git.listCommitSubjects(mergeBase);
  const detail = subjects.slice(0, 5).join(" • ") + (subjects.length > 5 ? " • …" : "");

  const choice = await vscode.window.showWarningMessage(
    `This branch already has ${existing} commit(s). Squash them with your new changes into a single commit for the MR?`,
    { modal: false, detail },
    "Squash into one commit",
    "Add as a new commit",
    "Cancel"
  );
  if (choice === undefined || choice === "Cancel") {
    return undefined;
  }
  if (choice === "Add as a new commit") {
    return none;
  }
  return { squashing: true, needsForce: pushed, mergeBase, existing };
}
