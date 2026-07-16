# Loopline

Automate the **Jira → branch → commit → push → merge-request** loop without leaving VS Code.

Loopline turns a Jira ticket key into a correctly-named branch, builds a conventional commit message from that branch, pushes to GitLab, and (optionally) opens a merge request with an auto-generated description.

---

## What it does

**Sidebar (Loopline view)**
Click the Loopline icon in the activity bar for a dedicated panel: a **Current** section showing the branch/ticket you're on (click for actions), and a ticket list below it. Click a ticket to start a branch from it, or use the inline icons to create a branch or open it in Jira.

Tickets are **grouped by status** (In Progress first, then To Do, …), and each row shows its type, priority (when it isn't the default), and how long ago it was updated. Tickets that **already have a local branch** are marked "on branch" — clicking one switches to that branch instead of creating another. Hovering a ticket reveals inline actions: create a branch, **open the ticket in VS Code** (a themed panel with the full description, no browser needed), or open it in Jira.

The title bar has two buttons:

- **Filter toggle** — switch between **My Active Sprint** and **All Open Tickets** in one click. The section header always reflects what's actually shown (including when a board has no sprints and Loopline falls back to all-open). This is the same scope used by the *Create Branch* picker, and it's remembered via `loopline.jira.ticketScope`.
- **Refresh** — reload the list.

Empty and error states are actionable rather than dead ends: an empty sprint offers *Show all open tickets*, and a failed load offers *Retry* and *Diagnose connection*.

**`Loopline: Create Branch from Jira Ticket`**
Pick from a list of your **active-sprint Jira tickets** (or type a key / paste a Jira URL if you prefer). Loopline maps the issue type to a branch prefix (`Bug → bugfix`, `Story/Task → feature`, all configurable), slugifies the title, lets you confirm or edit, then creates and checks out:

```
bugfix/LPB-1234-some-summary-issue
```

If a branch already exists for that ticket, Loopline stops and offers to **check out the existing branch**, **choose a different name**, or **cancel** — instead of silently landing you on the wrong branch.

After the branch is created, Loopline opens the **ticket in a single themed panel** — summary, type, status, and description, with buttons to create a branch, open the ticket in Jira, and (if AI is enabled) generate implementation suggestions right inside the panel. You can reopen it any time from the status-bar/sidebar ticket menu via **Open ticket in VS Code**. Toggle the auto-open with `loopline.showTicketDetailsOnBranch`.

Before creating the branch, Loopline can **fetch the base branch from origin** so you start from up-to-date code. By default it asks each time (`Update & branch` / `Branch from current HEAD` / `Cancel`); set `loopline.updateBaseBeforeBranch` to `always` or `never` to skip the prompt, and `loopline.baseBranch` to override the base (defaults to your MR target branch).

**`Loopline: Commit, Push & Create MR`**
Parses the ticket key and type back out of your current branch name, builds a conventional commit:

```
feat: LPB-1234 some summary issue
```

…stages your work, commits, pushes with upstream tracking, and optionally opens a GitLab MR.

**Staging respects your intent.** If you've staged files — or individual hunks via `git add -p` — Loopline commits *exactly that* and leaves everything else alone. If nothing is staged, it stages tracked modifications and asks before including untracked files, so a stray `debug.js` or `.env.local` never rides along unnoticed. Set `loopline.staging` to `pick` to always choose files, or `all` for the old `git add -A` behavior.

**One commit per MR.** Re-running the command on a branch that already has commits offers to squash them with your new work into a single commit and force-push with `--force-with-lease` (which fails safely if someone else pushed). You're always asked before history is rewritten; set `loopline.singleCommit` to `off` to keep every commit. It checks for an existing open MR first to avoid duplicates, and can pull the Jira ticket description into the MR body.

**Standup summary**
A megaphone icon in the Tickets view title bar (next to the sprint filter toggle) — or `Loopline: Generate Standup Summary` from the Command Palette — reads today's commits (by you, across all local branches), groups them by the ticket key already embedded in each commit message, and opens a themed panel with the draft, the same style as the ticket-details view, with a Copy to Clipboard button. With AI enabled it rephrases each ticket's commits into one short line; otherwise you get a plain bulleted list grouped by ticket — either way, it's grounded only in commits that actually happened.

**Impact footer**
Once you've created at least one branch, commit, or MR through Loopline, a row appears at the bottom of the sidebar: `12 branches · 8 commits · 5 MRs · ~3.5h saved`. It's hidden entirely until there's something to show. The time-saved figure is an estimate — `branches × loopline.impact.minutesPerBranch + commits × loopline.impact.minutesPerCommit + MRs × loopline.impact.minutesPerMr` (defaults: 15 / 5 / 10 minutes) — and the assumptions are always shown alongside it, in the tooltip and in the full breakdown you get by clicking the row (which also offers to reset the counters).

**Status-bar ticket indicator**
When you're on a branch that follows the convention, the status bar shows the ticket (e.g. `$(git-branch) LPB-1234`). Click it for quick actions: **Open Jira ticket**, **Open merge request** (finds the open MR for the current branch), **Copy ticket key**, or jump straight into create-branch / commit-push. It updates automatically when you switch branches — including from the terminal.

**Auto-transition the Jira ticket**
Optionally move the ticket through your workflow as you work: to *In Progress* when the branch is created, and *In Review* when the MR opens. Set the target status names in settings (`loopline.jira.transitionOnBranch` / `loopline.jira.transitionOnMr`); Loopline matches them against your project's available transitions and skips gracefully if the workflow doesn't allow it.

**AI-generated MR descriptions (opt-in)**
Instead of a bare file list, Loopline can draft a real MR body from the branch **diff** and the **ticket** (summary, description) using the Anthropic API: a Summary, the notable Changes, the Why tied back to the ticket, and Testing notes. It opens in an editor for you to review and edit before the MR is created, and falls back to the deterministic file-list description if AI is off, the key is missing, or the call fails.

**AI diff-vs-ticket check (opt-in)**
After staging and before the commit, Loopline can ask the AI whether your diff actually addresses what the ticket asks for — comparing it against the ticket's summary and description. If it looks complete, you're never interrupted. If it spots something the ticket mentions that the diff doesn't seem to cover, it pauses with a "Commit anyway / Cancel" prompt — advisory only, never a hard block. Turn it on with `loopline.ai.checkDiffAgainstTicket` (requires `loopline.ai.enabled`).

> **Privacy:** both AI features are off by default. When enabled, they send your diff and ticket text to the Anthropic API. If your code can't leave your environment, either leave them disabled or point `loopline.ai.baseUrl` at your company's Anthropic-compatible gateway. The API key is stored in VS Code Secret Storage.

---

## Install

### Option A — install the packaged extension (recommended)

1. Extensions panel (`Cmd/Ctrl+Shift+X`) → `···` menu → **Install from VSIX…**
2. Pick `loopline-0.16.0.vsix`.
3. Reload the window when prompted.

On reload you'll see a **`Loopline`** item in the status bar (bottom-left) confirming it's active, plus a **"Loopline is installed. Set up Jira + GitLab now?"** prompt.

### Option B — run from source (dev mode)

```bash
cd loopline
npm install
npm run compile
```

Then press **F5** to launch an Extension Development Host. To build your own `.vsix`:

```bash
npm run package   # requires: npm i -g @vscode/vsce
```

---

## First-run setup wizard

The wizard runs automatically on first activation, and any time from the Command Palette via **`Loopline: Run Setup Wizard`**. It's safe to re-run — every step pre-fills your current value, so you can rotate a single token without re-typing everything.

| Step | Asks for | Where to get it |
|------|----------|-----------------|
| 1 | Jira type (Cloud / Server) | Cloud = `*.atlassian.net` |
| 2 | Jira base URL | e.g. `https://acme.atlassian.net` |
| 3 | Jira email *(Cloud only)* | Your Atlassian login email |
| 4 | Jira token | Cloud: [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) · Server: Profile → Personal Access Tokens |
| 5 | GitLab host | Usually `https://gitlab.com` |
| 6 | GitLab token | GitLab → Settings → Access Tokens (scope: **api**) |
| 7 | Default MR target branch | e.g. `main` |
| 8 | AI MR descriptions (optional) | Enable + paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com) |

Tokens are stored in VS Code **Secret Storage**, never in `settings.json`.

---

## Day-to-day usage

**Start a ticket**
`Cmd/Ctrl+Shift+P` → **Loopline: Create Branch from Jira Ticket** → pick one of your assigned tickets (or enter a key) → confirm the branch name → you're on the branch.

You can also trigger both main actions from buttons at the top of the **Source Control** view. For diagnostics, run **Loopline: Show Logs** to open the Loopline output channel.

**Ship it**
`Cmd/Ctrl+Shift+P` → **Loopline: Commit, Push & Create MR** → type a one-line summary → choose *commit+push+MR* or *commit+push only*. If you chose MR, click **Open MR** in the confirmation toast.

---

## Settings

All under `loopline.*` in Settings (or `settings.json`):

| Setting | Purpose |
|---------|---------|
| `loopline.jira.type` | `cloud` or `server` |
| `loopline.jira.baseUrl` | Jira base URL |
| `loopline.jira.email` | Cloud email (Basic auth) |
| `loopline.gitlab.host` | Defaults to `https://gitlab.com` |
| `loopline.gitlab.projectId` | Pin a project id / `group/path`; blank = auto-detect from `origin` |
| `loopline.defaultTargetBranch` | MR target branch |
| `loopline.branchTypeMapping` | Jira issue type → branch prefix |
| `loopline.commitTypeMapping` | Branch prefix → commit prefix (`feature → feat`) |
| `loopline.branchNameTemplate` | Branch name shape. Tokens: `{prefix}`, `{ticket}`, `{slug}` (default `{prefix}/{ticket}-{slug}`, i.e. today's format) |
| `loopline.commitMessageTemplate` | Commit message shape. Tokens: `{prefix}`, `{ticket}`, `{summary}` (default `{prefix}: {ticket} {summary}`, i.e. today's format) |
| `loopline.confirmBranchName` | Show branch name for confirmation before creating |
| `loopline.mr.includeJiraDescription` | Include ticket description in the MR body |
| `loopline.protectedBranches` | Branches you're warned about before committing directly (default `main`, `master`, `develop`) |
| `loopline.staging` | What gets staged: `respectStaged` (default), `pick`, or `all` |
| `loopline.singleCommit` | Keep the MR at one commit by squashing: `squash` (default) or `off` |
| `loopline.jira.transitionOnBranch` | Status to move the ticket to on branch creation (e.g. `In Progress`); blank = off |
| `loopline.jira.transitionOnMr` | Status to move the ticket to on MR creation (e.g. `In Review`); blank = off |
| `loopline.jira.ticketScope` | Which assigned issues the branch picker lists: `activeSprint` (default) or `allOpen` |
| `loopline.sidebar.groupByStatus` | Group sidebar tickets under their Jira status (default on) |
| `loopline.ai.enabled` | Opt in to AI-generated MR descriptions (off by default) |
| `loopline.ai.model` | Anthropic model id (default `claude-sonnet-5`) |
| `loopline.ai.baseUrl` | Anthropic API base URL / company gateway (default `https://api.anthropic.com`) |
| `loopline.ai.maxDiffBytes` | Max diff size sent to the AI before truncation (default `60000`) |
| `loopline.showTicketDetailsOnBranch` | After branch creation, open ticket details and offer AI implementation suggestions (default on) |
| `loopline.baseBranch` | Branch to base new branches on; blank uses the MR target branch |
| `loopline.updateBaseBeforeBranch` | Fetch the base before branching: `ask` (default), `always`, or `never` |
| `loopline.http.proxy` | Proxy for Jira/GitLab/AI requests (Node ignores the OS proxy); overrides `HTTPS_PROXY` |
| `loopline.http.extraCaCerts` | Paths to extra CA certificates (Node ignores the Windows cert store) |
| `loopline.http.allowInsecureTls` | ⚠️ Disable TLS verification — insecure, last resort only |

Example custom mappings and transitions:

```jsonc
"loopline.branchTypeMapping": { "Bug": "bugfix", "Story": "feature", "Spike": "chore" },
"loopline.commitTypeMapping": { "feature": "feat", "bugfix": "fix", "chore": "chore" },
"loopline.jira.transitionOnBranch": "In Progress",
"loopline.jira.transitionOnMr": "In Review"
```

## Team-shared config (`.loopline.json`)

By default, every setting above is personal — it lives in your own VS Code settings. If a team wants everyone to share the same conventions without each person configuring VS Code by hand, run **`Loopline: Create Project Config File`**. It scaffolds a `.loopline.json` at the repo root, pre-filled with every shareable field from your current settings, and opens it for editing. Commit the file so the rest of the team gets it automatically on clone.

This is entirely opt-in and never happens on its own: Loopline never creates or writes `.loopline.json` unless you explicitly run that command (or someone hand-writes the file). If the file isn't there, nothing about Loopline's behavior changes.

```jsonc
// .loopline.json — committed at the repo root
{
  "branchTypeMapping": { "Bug": "bugfix", "Story": "feature" },
  "commitTypeMapping": { "bugfix": "fix", "feature": "feat" },
  "protectedBranches": ["main", "release"],
  "defaultTargetBranch": "main",
  "jiraTransitionOnBranch": "In Progress",
  "jiraTransitionOnMr": "In Review",
  "jiraTicketScope": "activeSprint",
  "staging": "respectStaged",
  "singleCommit": "squash",
  "branchNameTemplate": "{prefix}/{ticket}-{slug}",
  "commitMessageTemplate": "{prefix}: {ticket} {summary}"
}
```

**Precedence:** an explicit personal or workspace setting always wins over `.loopline.json` — the file only fills in for whoever hasn't customized that particular setting themselves, so it standardizes without silently overriding a deliberate local choice. Only the fields above are recognized; secrets, tokens, your Jira email, AI on/off, and proxy/CA settings stay personal and are never read from this file.

---

## Troubleshooting

### Can't connect to a self-hosted Jira/GitLab (corporate networks)

Run **`Loopline: Diagnose Connection`** — it writes a full report to the Loopline output channel: your OS/Node version, the effective proxy, loaded CA certificates, DNS resolution for each host, and a live API call with the exact failure code. Start there; the `code=…` value identifies the cause.

Two things catch out corporate/self-hosted setups, **especially on Windows**:

**Node doesn't use the OS proxy.** Your browser reaches an internal Jira while Loopline can't. Fix: set `loopline.http.proxy` (or the `HTTPS_PROXY` environment variable):

```jsonc
"loopline.http.proxy": "http://proxy.corp.com:8080"
```

`NO_PROXY` is respected for hosts that should bypass the proxy.

**Node doesn't use the Windows certificate store.** If your Jira/GitLab uses a private/corporate CA, or your network inspects HTTPS, requests fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` even though Windows trusts the cert. Fix: point Loopline at the root CA file:

```jsonc
"loopline.http.extraCaCerts": ["C:\\certs\\corp-root-ca.pem"]
```

(`NODE_EXTRA_CA_CERTS` is also honored. As a last resort `loopline.http.allowInsecureTls` disables verification — but it defeats HTTPS and exposes your tokens, so prefer the CA file.)

Common codes and what they mean:

| Code | Cause |
|------|-------|
| `ENOTFOUND` | DNS failed — check VPN for internal hosts |
| `ETIMEDOUT` | Unreachable — often a proxy is required |
| `ECONNREFUSED` | Nothing listening — check URL/VPN/firewall |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN` | Private/corporate CA not trusted by Node → `extraCaCerts` |
| `ECONNRESET`, `EPROTO` | Proxy or TLS-inspecting firewall interfering |

### Other issues

- **Command "runs" but nothing appears** — check the notifications bell / Do Not Disturb in the status bar; VS Code doesn't steal focus for info messages. The `Loopline` status-bar item confirms the extension is active.
- **401 / 403 from Jira or GitLab** — token expired or wrong; re-run the setup wizard.
- **"GitLab project not found"** — origin remote couldn't be parsed; set `loopline.gitlab.projectId` explicitly.
- **Commit command asks for the ticket manually** — your branch name doesn't match `prefix/TICKET-KEY-slug`; that's the fallback, not a failure.
- **Multi-root / multi-repo workspace** — Loopline resolves the repo of the file you're viewing, discovers repos across all workspace folders (including a container folder holding several), and remembers your last choice per workspace.

---

## Extending it

- **MR body** — `buildMrDescription()` in `src/commands/commitAndPush.ts`.
- **Jira field mapping** — `src/services/jira.ts` (`getIssue`).
- **Remote URL parsing** — `parseRemoteUrl()` in `src/services/git.ts`.
- **Next high-value additions:** MR reviewers/labels/draft support, and unit tests around `src/util/text.ts`.

MIT licensed.
