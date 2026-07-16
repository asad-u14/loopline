import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { GitService, findRepoRootForDir } from "../services/git";
import { JiraService } from "../services/jira";
import { GitLabService } from "../services/gitlab";
import { AnthropicService } from "../services/anthropic";
import {
  readConfig,
  getJiraToken,
  getGitLabToken,
  getAnthropicKey,
  httpOptionsFromConfig,
} from "./config";
import { withCancellableProgress, isCancelled } from "./progress";

const LAST_REPO_KEY = "loopline.lastRepoRoot";

// Directories never worth scanning for nested repos.
const SKIP_DIRS = new Set([
  "node_modules", "dist", "out", "out-test", "build", "target",
  ".git", ".vscode", ".idea", "vendor", "coverage",
]);

/**
 * Resolve which git repository to operate on. Git-aware, so it works when a
 * workspace folder is inside a larger repo, or is a container holding several
 * repos. Resolution order:
 *   1. The repo containing the active editor's file (what you're looking at).
 *   2. The single repo discovered across workspace folders.
 *   3. A quick-pick across all discovered repos, defaulting to the last one
 *      used in this workspace.
 */
export async function resolveRepoRoot(
  ctx?: vscode.ExtensionContext
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("Loopline: open a folder or workspace first.");
    return undefined;
  }

  // 1. Active file's repo — almost always the one the user means.
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && activeUri.scheme === "file") {
    const root = await findRepoRootForDir(path.dirname(activeUri.fsPath));
    if (root) {
      await remember(ctx, root);
      return root;
    }
  }

  // 2. Discover every git repo reachable from the workspace folders.
  const repos = await discoverRepos(folders.map((f) => f.uri.fsPath));
  if (repos.length === 0) {
    vscode.window.showErrorMessage("Loopline: no git repository found in this workspace.");
    return undefined;
  }
  if (repos.length === 1) {
    await remember(ctx, repos[0]);
    return repos[0];
  }

  // 3. Multiple repos — ask, defaulting to the last one used here.
  const last = ctx?.workspaceState.get<string>(LAST_REPO_KEY);
  const items = await Promise.all(
    repos.map(async (root) => {
      const branch = await safeBranch(root);
      return {
        label: path.basename(root) || root,
        description: branch ? `$(git-branch) ${branch}` : "",
        detail: root === last ? `${root}  •  last used` : root,
        repoPath: root,
      };
    })
  );
  items.sort((a, b) => (a.repoPath === last ? -1 : b.repoPath === last ? 1 : 0));

  const pick = await vscode.window.showQuickPick(items, {
    title: "Loopline: which repository?",
    placeHolder: "This workspace contains multiple git repositories",
    ignoreFocusOut: true,
    matchOnDetail: true,
  });
  if (!pick) {
    return undefined;
  }
  await remember(ctx, pick.repoPath);
  return pick.repoPath;
}

/**
 * Find distinct git repo roots across the given folders. If a folder is itself
 * inside a repo, that repo root is used; otherwise we look one level down for
 * repos (the "container folder of several repos" case).
 */
async function discoverRepos(dirs: string[]): Promise<string[]> {
  const roots = new Set<string>();
  for (const dir of dirs) {
    const own = await findRepoRootForDir(dir);
    if (own) {
      // dir is a repo (or lives inside one) — nested children share that root.
      roots.add(own);
      continue;
    }
    // dir isn't in a repo: check its immediate subdirectories.
    for (const child of listSubdirs(dir)) {
      const childRoot = await findRepoRootForDir(child);
      if (childRoot) {
        roots.add(childRoot);
      }
    }
  }
  return [...roots];
}

function listSubdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

async function safeBranch(root: string): Promise<string> {
  try {
    return await new GitService(root).currentBranch();
  } catch {
    return "";
  }
}

async function remember(ctx: vscode.ExtensionContext | undefined, root: string): Promise<void> {
  await ctx?.workspaceState.update(LAST_REPO_KEY, root);
}

/**
 * Resolve the "current" repo WITHOUT prompting — for background UI like the
 * status bar. Prefers the active file's repo, then the last-used repo, then the
 * first discovered repo. Returns undefined if none.
 */
export async function currentRepoQuiet(
  ctx?: vscode.ExtensionContext
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && activeUri.scheme === "file") {
    const root = await findRepoRootForDir(path.dirname(activeUri.fsPath));
    if (root) {
      return root;
    }
  }
  const repos = await discoverRepos(folders.map((f) => f.uri.fsPath));
  if (repos.length === 0) {
    return undefined;
  }
  const last = ctx?.workspaceState.get<string>(LAST_REPO_KEY);
  if (last && repos.includes(last)) {
    return last;
  }
  return repos[0];
}

/**
 * Best-effort Jira workflow transition. Non-fatal: reports success/skip/failure
 * but never blocks the surrounding command.
 */
export async function tryTransitionTicket(
  ctx: vscode.ExtensionContext,
  ticketKey: string,
  targetStatus: string
): Promise<void> {
  if (!targetStatus) {
    return;
  }
  const jira = await buildJiraService(ctx);
  if (!jira) {
    return;
  }
  try {
    const result = await withCancellableProgress(
      `Loopline: updating ${ticketKey} → ${targetStatus}…`,
      (signal) => jira.transitionTo(ticketKey, targetStatus, signal)
    );
    if (result.applied) {
      vscode.window.showInformationMessage(`Loopline: ${ticketKey} moved to "${result.applied}".`);
    } else if (result.skipped) {
      vscode.window.showWarningMessage(`Loopline: ${ticketKey} not moved — ${result.skipped}.`);
    }
  } catch (err) {
    if (isCancelled(err)) {
      return;
    }
    vscode.window.showWarningMessage(
      `Loopline: couldn't transition ${ticketKey} — ${(err as Error).message}`
    );
  }
}

export async function buildJiraService(
  ctx: vscode.ExtensionContext
): Promise<JiraService | undefined> {
  const cfg = readConfig();
  const token = await getJiraToken(ctx);
  if (!token || !cfg.jiraBaseUrl) {
    return undefined;
  }
  return new JiraService({
    type: cfg.jiraType,
    baseUrl: cfg.jiraBaseUrl,
    email: cfg.jiraEmail,
    token,
    http: httpOptionsFromConfig(),
  });
}

export async function buildGitLabService(
  ctx: vscode.ExtensionContext
): Promise<GitLabService | undefined> {
  const cfg = readConfig();
  const token = await getGitLabToken(ctx);
  if (!token) {
    return undefined;
  }
  return new GitLabService(cfg.gitlabHost, token, undefined, httpOptionsFromConfig());
}

/** Returns an Anthropic service only when the AI feature is enabled AND a key exists. */
export async function buildAnthropicService(
  ctx: vscode.ExtensionContext
): Promise<AnthropicService | undefined> {
  const cfg = readConfig();
  if (!cfg.aiEnabled) {
    return undefined;
  }
  const key = await getAnthropicKey(ctx);
  if (!key) {
    return undefined;
  }
  return new AnthropicService({
    apiKey: key,
    baseUrl: cfg.aiBaseUrl,
    model: cfg.aiModel,
    maxDiffBytes: cfg.aiMaxDiffBytes,
    http: httpOptionsFromConfig(),
  });
}

/**
 * Determine the GitLab project id: pinned setting first, else auto-detect
 * from the origin remote.
 */
export async function resolveGitLabProject(
  git: GitService
): Promise<string | undefined> {
  const cfg = readConfig();
  if (cfg.gitlabProjectId) {
    return cfg.gitlabProjectId;
  }
  const info = await git.getOriginInfo();
  return info?.projectPath;
}
