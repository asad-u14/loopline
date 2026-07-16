# Changelog

All notable changes to Loopline are documented here.

## [0.19.0] — 2026-07-16
### Added
- **Impact footer.** Once you've created at least one branch, commit, or MR through Loopline, a row pins to the bottom of the sidebar: `12 branches · 8 commits · 5 MRs · ~3.5h saved`. Hidden until there's something to show. The time-saved figure is a clearly-labeled estimate (`loopline.impact.minutesPerBranch` / `minutesPerCommit` / `minutesPerMr`, defaults 15 / 5 / 10) — the assumptions are always visible alongside it. Clicking the row opens the full breakdown with a "Reset counters" option. Added `Loopline: Show Impact`.

## [0.18.0] — 2026-07-16
### Added
- **AI diff-vs-ticket check (opt-in).** After staging and before the commit, Loopline can ask the AI whether the diff actually addresses what the ticket asks for, comparing it against the ticket's summary and description. A clean verdict is silent; a possible gap pauses with a "Commit anyway / Cancel" prompt — advisory only, and the check itself never blocks a commit if it fails or is cancelled. Off by default; turn on with `loopline.ai.checkDiffAgainstTicket` (requires `loopline.ai.enabled`).

### Changed
- The Jira ticket fetch used for the MR description now happens once, earlier in the commit flow, so the new pre-commit check and the MR description share the same fetch instead of hitting Jira twice.

## [0.17.0] — 2026-07-16
### Added
- **Colorful ticket icons.** Each ticket's icon is now tinted by issue type — Bug red, Story green, Epic purple, Sub-task orange, Task/other blue — so you can spot a type at a glance without reading the row. Turn it off with `loopline.sidebar.colorfulIcons`.

### Changed
- **Only "In Progress" expands by default.** When tickets are grouped by status, the In Progress group now opens expanded and every other group (To Do, Done, …) starts collapsed, so the sidebar leads with what you're actively working on instead of the whole backlog.

## [0.16.0] — 2026-07-15
### Added
- **Open Ticket in VS Code** from the sidebar. Every ticket row now has an inline button (between *Create Branch* and *Open in Jira*) that opens the ticket's details in the Loopline panel — full description, no browser round-trip. It reuses the same panel as the post-branch-creation view, so opening another ticket updates it rather than stacking tabs. Added `Loopline: Open Ticket in VS Code`.
- If the ticket fetch fails, the panel still opens with what the sidebar already knows (key, summary, type, status) and warns, instead of showing nothing.

### Changed
- The ticket-details view had two implementations — one private to the status-bar action menu and one for the sidebar. They're now a single shared command, so both entry points behave identically and gain the offline fallback above.

## [0.15.0] — 2026-07-15
### Added
- **Branch-aware tickets.** The sidebar now marks tickets that already have a local branch ("on branch"), so you can see at a glance what you've started. Clicking such a ticket switches to that branch (asking which, if several match) instead of starting another; creating a branch and opening in Jira remain available inline. Local branches are read once per refresh, not once per ticket. Added `Loopline: Switch to this Ticket's Branch`.
- **Grouping by status.** Tickets are grouped under their Jira status, ordered In Progress → To Do → Done → other, with a count on each group. Grouping is skipped automatically when every ticket shares one status, and can be turned off with `loopline.sidebar.groupByStatus`.
- **Richer rows.** Rows now show priority and how long ago the ticket was updated, and the tooltip carries the full detail (status, priority, age, branches). Priority is hidden when it's the uninformative default (Medium/None). Status isn't repeated inside its own group. The Jira query now also fetches `priority`, `updated`, and the status category.

### Fixed
- **`branchesForTicket` matched by bare substring**, so `LPB-1` also matched branches for `LPB-12`, `LPB-1234`, and so on — meaning the existing-branch guard could offer to check out an unrelated ticket's branch. Matching is now boundary-aware (the key must not be followed by another digit).

## [0.14.0] — 2026-07-15
### Added
- **Staging that respects your intent** (`loopline.staging`, default `respectStaged`). If anything is staged — including individual hunks staged with `git add -p` — Loopline now commits exactly that and leaves the index untouched. If nothing is staged it stages tracked modifications only, and **never includes untracked files without asking**. Modes: `respectStaged`, `pick` (choose files from a list, staged ones pre-selected), and `all` (the previous `git add -A`).
- **One commit per merge request** (`loopline.singleCommit`, default `squash`). Re-running the commit command on a branch that already has commits offers to collapse them, together with your new work, into a single commit and force-push with `--force-with-lease` (which fails safely if someone else pushed). The first commit on a branch needs nothing. History is never rewritten without an explicit prompt that lists the commits involved; set to `off` to keep every commit.
- The commit-summary prompt now states how many files are about to be committed.

### Fixed
- **`git add -A` swept unrelated work into every commit.** It staged all modified files *and* all untracked files, so an unrelated README tweak, a scratch `debug.js`, or a non-ignored `.env.local` would silently join the commit (and the MR description) — a real way to commit a secret. It also destroyed deliberate hunk-level staging by committing hunks you'd left out.
- **The AI/MR description could describe changes that weren't committed.** The diff came from `git diff HEAD` (working tree vs HEAD) captured before staging. It is now read from the index (`git diff --cached`) after staging, and the MR file list comes from the staged files, so both describe exactly what was committed.

## [0.13.0] — 2026-07-15
### Added
- **Sidebar scope toggle.** A filter button in the Tickets view title bar (next to Refresh) switches between **My Active Sprint** and **All Open Tickets** in one click — no more editing settings. Only the relevant button is shown at a time, and the choice persists via `loopline.jira.ticketScope`, so the sidebar and the *Create Branch* picker always agree.
- **Actionable empty/error states.** An empty sprint now offers *Show all open tickets*; a failed load offers *Retry* and *Diagnose connection*, instead of a dead-end message.

### Fixed
- **The tickets section was always labelled "My Active Sprint"**, even when `ticketScope` was `allOpen` (it listed the whole backlog under a sprint heading). The label now reflects the active scope.
- The label also tells the truth when an active-sprint request **falls back** to all-open on a board without sprints — it reads "All Open Tickets (no sprints)" rather than claiming a sprint filter that wasn't applied. The *Create Branch* picker's placeholder was corrected the same way. `JiraService.getMyOpenIssues` now reports whether the sprint filter was actually applied.
- Changing the scope now invalidates the cached ticket list, and editing `loopline.jira.ticketScope` directly in settings updates the sidebar immediately.
- `loopline.jira.ticketScope`'s description said it only affected the *Create Branch* picker; it drives the sidebar too.

## [0.12.0] — 2026-07-15
### Added
- **Proxy support.** Jira/GitLab/AI requests now honor `HTTPS_PROXY`/`HTTP_PROXY` (and `NO_PROXY`), plus a `loopline.http.proxy` override. Node does not use the OS proxy, which is why a browser could reach an internal Jira while Loopline silently couldn't — especially on Windows.
- **Corporate CA support.** `loopline.http.extraCaCerts` (and `NODE_EXTRA_CA_CERTS`) let Loopline trust private/corporate CAs. Node doesn't use the Windows certificate store, so self-hosted Jira/GitLab behind a corporate CA or an HTTPS-inspecting proxy previously failed with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Also added `loopline.http.allowInsecureTls` as a clearly-marked, discouraged last resort.
- **Full request logging.** Every API request, response status, timing, and failure is now written to the Loopline output channel — including the raw Node error code (`ENOTFOUND`, `ECONNREFUSED`, `SELF_SIGNED_CERT_IN_CHAIN`, …) and a plain-English hint for what to fix. Previously these failures produced a generic message and an empty log.
- **`Loopline: Diagnose Connection` command.** One-click report to the output channel: OS/Node/VS Code versions, proxy environment and effective proxy per target, loaded CA certificates, DNS resolution, and a live authenticated call to each configured service with the precise failure code. Tokens are never logged.
- Error messages across Jira, GitLab, and Anthropic now surface the underlying network/TLS cause instead of a generic "couldn't reach".

### Fixed
- **Corporate CA through a proxy.** `https-proxy-agent` v7 resets its `options` in the constructor, so TLS options only applied to the proxy hop and the destination handshake still failed — breaking the most common corporate setup (proxy **and** private CA together). Verified with a live CONNECT proxy and a self-signed origin; covered by a regression test.
- `loadCaCerts`/`buildHttpConfig` read `NODE_EXTRA_CA_CERTS` from the process environment directly, making behavior non-deterministic. The environment is now injectable (still defaulting to `process.env`).

## [0.11.0] — 2026-07-14
### Changed
- **Ticket details are now a single, themed webview panel** instead of a raw Markdown document plus its preview (which opened two tabs). The panel shows summary, type, status, and a rendered description, matches your VS Code theme, and hosts in-panel actions: *Create branch from this ticket*, *Open in Jira*, and — when AI is enabled — *Generate implementation suggestions*, which renders the plan inside the same panel. Reuses one panel rather than stacking tabs.

### Added
- **Open ticket in VS Code** action in the current-branch/ticket menu (status bar and sidebar), which opens the themed detail panel.
- The fetched Jira issue now includes **status**, shown on the detail panel.
- A small, unit-tested Markdown→HTML renderer (escape-first, XSS-safe) powers the panel's description and AI-plan rendering.

## [0.10.0] — 2026-07-14
### Added
- **Loopline sidebar (activity-bar Tree View).** A dedicated panel with a **Current** section (the branch/ticket you're on, click for actions) and a **My Active Sprint** section listing your tickets. Click a ticket to start a branch from it, or use inline actions to create a branch / open it in Jira. Includes a refresh button, a first-run welcome with a *Run Setup* button, per-issue-type icons, and live updates when the branch changes.

## [0.9.0] — 2026-07-13
### Added
- **Branch from an up-to-date base.** Before creating a branch, Loopline can fetch the base branch from origin and start the new branch at `origin/<base>`, so you don't branch off stale code. Controlled by `loopline.updateBaseBeforeBranch` (`ask` default / `always` / `never`) and `loopline.baseBranch` (defaults to the MR target). Degrades gracefully to branching from HEAD if the fetch or base ref fails.
- **Source Control view buttons** for *Create Branch* and *Commit, Push & Create MR* (top of the SCM view, git repos only).
- **Output channel + `Loopline: Show Logs` command** for diagnostics; internal errors and setting-write failures are now logged there.

### Fixed
- `revExists` / branch-diff base resolution treated a non-resolving ref as existing (simple-git returns empty output rather than erroring on `rev-parse --verify --quiet`). Both now require non-empty output.

## [0.8.1] — 2026-07-13
### Fixed
- GitLab credential verification no longer fails setup on a 403 from `/user`. That endpoint is commonly forbidden for group/project access tokens and narrow scopes even when the token can create MRs, so verification now treats 401 as a bad token but a 403 as "authenticated" — it falls back to `/version` and, failing that, accepts the token (MR scope is validated when an MR is actually created). MR-operation 403s now return a clearer message about needing `api` scope and Developer access.

## [0.8.0] — 2026-07-13
### Added
- **Ticket details on branch creation.** After creating a branch, Loopline opens the ticket description in a rendered Markdown window so the requirements are in front of you. Toggle with `loopline.showTicketDetailsOnBranch` (default on).
- **AI implementation suggestions (opt-in, on request).** From that step, if AI is enabled, Loopline offers to draft a starting implementation plan from the ticket (Goal / Suggested approach / Likely areas to change / Edge cases / Tests / Open questions), lightly grounded by the repo's top-level layout, and opens it in its own window. Nothing is sent unless you click *Generate*. Added unit tests for the plan prompt builder.

## [0.7.0] — 2026-07-13
### Changed
- The *Create Branch* picker now lists only your **active-sprint** tickets by default (JQL `sprint in openSprints()`), instead of all open assigned issues. It falls back automatically to all-open on boards/projects without sprints (Kanban, Jira Core, or Server without Jira Software). New setting `loopline.jira.ticketScope` (`activeSprint` | `allOpen`) controls this. Added a unit test for the JQL builder.

## [0.6.1] — 2026-07-13
### Fixed
- The setup wizard no longer aborts if VS Code rejects a settings write (e.g. "not a registered configuration" after updating the extension in place against a stale manifest). Failed writes now warn once with a reload hint and setup continues; entered tokens/keys are stored regardless. Reloading the window resolves the underlying stale-manifest state.

## [0.6.0] — 2026-07-13
### Added
- **Assigned-tickets picker.** *Create Branch from Jira Ticket* now lists your open assigned Jira issues (JQL `assignee = currentUser() AND resolution = Unresolved`) to pick from, with issue type and status shown — no more typing keys from memory. Manual key/URL entry is still available, and it falls back to manual entry if the search can't be reached. Uses `/rest/api/3/search/jql` on Cloud and `/rest/api/2/search` on Server/DC.
- **Existing-branch handling.** If a branch already exists for the ticket (exact name or any branch containing the key), Loopline now stops and offers **Check out existing** / **Choose a different name** / **Cancel** (with a sub-picker when several branches match), instead of silently checking out an existing branch. Added integration tests for branch discovery.

## [0.5.0] — 2026-07-13
### Added
- **AI-generated merge-request descriptions (opt-in).** With `loopline.ai.enabled`, Loopline drafts the MR body from the branch diff and the Jira ticket via the Anthropic Messages API (Summary / Changes / Why / Testing), opens it in an editor for review and edit, and posts the edited text. Falls back to the deterministic file-list description if AI is disabled, the key is missing, the diff is empty, or the call fails.
  - Configurable model (`loopline.ai.model`, default `claude-sonnet-5`), base URL for company gateways / proxies (`loopline.ai.baseUrl`), and diff size cap (`loopline.ai.maxDiffBytes`).
  - API key stored in Secret Storage; added `Loopline: Set AI (Anthropic) API Key` and an optional step 8 in the setup wizard (with live key validation).
  - Off by default; sends diff + ticket text to the API only when explicitly enabled. Added unit tests for the prompt builder and diff-truncation logic.

## [0.4.0] — 2026-07-13
### Added
- **Status-bar ticket indicator.** Shows the Jira ticket for the current branch and updates automatically on branch switches (including external `git checkout`, via a `.git/HEAD` watcher). Clicking opens an action menu: Open Jira ticket, Open merge request (finds the open MR for the current branch), Copy ticket key, or jump into create-branch / commit-push. Added `Loopline: Ticket Actions` command.
- **Auto-transition the Jira ticket.** Optionally move the ticket through your workflow — to a configured status on branch creation (`loopline.jira.transitionOnBranch`, e.g. *In Progress*) and on MR creation (`loopline.jira.transitionOnMr`, e.g. *In Review*). Matching is forgiving (destination status or transition name, exact then partial) and non-fatal: if the workflow doesn't allow it, Loopline reports what's available and moves on. Added unit tests for the transition matcher.

## [0.3.1] — 2026-07-13
### Changed
- **Git-aware multi-repo resolution.** Repo selection no longer assumes a workspace folder is a git repo root. Loopline now resolves the repository containing the file you're viewing, discovers distinct repos across all workspace folders (including a non-repo container folder that holds several repos, or a folder nested inside a larger repo), shows each candidate's current branch in the picker, and remembers your last choice per workspace. Added an integration test covering repo-root discovery.

## [0.3.0] — 2026-07-13
### Added
- **esbuild bundling.** The extension and its runtime deps (axios, simple-git) are now bundled into a single `dist/extension.js`, so the packaged `.vsix` ships a handful of files instead of ~300 — faster activation, smaller download.
- **Unit test suite** (`node --test`) covering branch/commit name building and parsing (`text.ts`) and Git remote-URL parsing, wired into a GitHub Actions CI workflow (type-check → test → bundle → package).
- **Cancellable operations.** Jira fetches and GitLab MR calls now run under a cancellable progress and abort the underlying request when you click Cancel.
- **Pre-flight guards** in *Commit, Push & Create MR*: blocks on a detached HEAD, blocks when there's no `origin` remote, and warns before committing directly onto a protected branch.
- **`loopline.protectedBranches`** setting (default `main`, `master`, `develop`).
- **Settings validation** on activation and on change — catches a hand-broken `branchTypeMapping`/`commitTypeMapping`, bad URLs, or an invalid `jira.type`.

### Changed
- Real timeouts on git subprocesses via simple-git's block timeout, so a hung push no longer waits forever.

## [0.2.2] — 2026-07-13
### Added
- Live credential validation in the setup wizard (Jira `/myself`, GitLab `/user`) with a re-enter / save-anyway / cancel choice on failure.
- Friendlier, more specific Jira/GitLab error messages (wrong URL vs bad token vs unreachable host).

## [0.2.0] — 2026-07-13
### Changed
- Renamed to **Loopline** with the loop-cycle icon.
- Standardised the `loopline.*` namespace for commands and settings.

## [0.1.0]
- Initial internal build: branch-from-ticket, commit/push, GitLab MR creation, setup wizard.
