import axios, { AxiosInstance, AxiosError } from "axios";
import { JiraType } from "../util/config";
import { OperationCancelled } from "../util/progress";
import {
  JiraTransition,
  pickTransition,
  describeTransitions,
} from "../util/jira-transitions";
import { buildMyIssuesJql } from "../util/jira-jql";
import { createHttpClient, pickCode } from "../util/http-client";
import { explainNetworkCode, HttpOptions } from "../util/http";

export interface JiraIssue {
  key: string;
  summary: string;
  issueType: string;
  description: string;
  status: string;
  assignee?: string;
  reporter?: string;
  priority?: string;
  labels: string[];
  created?: string;
  updated?: string;
}

/** Lightweight issue shape for the assigned-tickets picker and sidebar. */
export interface JiraIssueSummary {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  /** Jira status category key: "new" | "indeterminate" | "done". Used for ordering. */
  statusCategory?: string;
  priority?: string;
  /** ISO timestamp of the last update. */
  updated?: string;
}

export interface JiraServiceOptions {
  type: JiraType;
  baseUrl: string;
  email: string;   // Cloud only
  token: string;
  timeoutMs?: number;
  http?: HttpOptions;
}

export class JiraError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "JiraError";
  }
}

/** Result of an issue search, including whether the sprint filter actually applied. */
export interface MyIssuesResult {
  issues: JiraIssueSummary[];
  /** False when the sprint clause was dropped (board/project has no sprints). */
  sprintFilterApplied: boolean;
}

export class JiraService {
  private http: AxiosInstance;

  constructor(private opts: JiraServiceOptions) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    if (opts.type === "cloud") {
      // Basic auth: base64(email:apiToken)
      const basic = Buffer.from(`${opts.email}:${opts.token}`).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    } else {
      // Server / Data Center: Personal Access Token as Bearer
      headers.Authorization = `Bearer ${opts.token}`;
    }

    this.http = createHttpClient({
      label: "Jira",
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs ?? 15000,
      headers,
      http: opts.http,
    });
  }

  /**
   * Cheap authenticated call to confirm the base URL + credentials work.
   * Returns the authenticated user's display name.
   */
  async verify(): Promise<string> {
    try {
      const res = await this.http.get("/rest/api/2/myself", {
        params: { expand: "" },
      });
      return res.data?.displayName || res.data?.name || res.data?.emailAddress || "Jira user";
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status;
      if (status === 401 || status === 403) {
        const hint =
          this.opts.type === "cloud"
            ? "Check the email + API token (Cloud uses Basic auth)."
            : "Check the Personal Access Token (Server/DC uses Bearer auth).";
        throw new JiraError(`Jira rejected your credentials (${status}). ${hint}`, status);
      }
      if (status === 404) {
        throw new JiraError(
          "Reached the host but /rest/api/2/myself was 404 — the base URL is probably wrong.",
          status
        );
      }
      const code = pickCode(ax);
      const explained = explainNetworkCode(code);
      if (explained) {
        throw new JiraError(`Couldn't reach Jira (${code}). ${explained}`);
      }
      throw new JiraError(ax.message || "Unknown Jira error", status);
    }
  }

  /** Fetch a single issue and normalize the fields we care about. */
  async getIssue(key: string, signal?: AbortSignal): Promise<JiraIssue> {
    try {
      const res = await this.http.get(
        `/rest/api/2/issue/${encodeURIComponent(key)}`,
        {
          params: {
            fields: "summary,issuetype,description,status,assignee,reporter,priority,labels,created,updated",
          },
          signal,
        }
      );
      const fields = res.data?.fields ?? {};
      return {
        key: res.data?.key ?? key,
        summary: fields.summary ?? "",
        issueType: fields.issuetype?.name ?? "",
        description: this.renderDescription(fields.description),
        status: fields.status?.name ?? "",
        assignee: fields.assignee?.displayName,
        reporter: fields.reporter?.displayName,
        priority: fields.priority?.name,
        labels: Array.isArray(fields.labels) ? fields.labels : [],
        created: fields.created,
        updated: fields.updated,
      };
    } catch (err) {
      throw this.toFriendlyError(err, key);
    }
  }

  /**
   * Jira Cloud returns descriptions in Atlassian Document Format (ADF, an object);
   * Server returns plain text/wiki markup (a string). Flatten either to plain text.
   */
  private renderDescription(desc: unknown): string {
    if (!desc) {
      return "";
    }
    if (typeof desc === "string") {
      return desc;
    }
    // Best-effort ADF -> text walk.
    const out: string[] = [];
    const walk = (node: any) => {
      if (!node) {
        return;
      }
      if (typeof node.text === "string") {
        out.push(node.text);
      }
      if (Array.isArray(node.content)) {
        node.content.forEach(walk);
        // paragraph / block-level nodes get a newline after them
        if (["paragraph", "heading", "listItem", "blockquote"].includes(node.type)) {
          out.push("\n");
        }
      }
    };
    walk(desc);
    return out.join("").replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * Open issues assigned to the authenticated user, most recently updated first.
   * When `activeSprintOnly` is set, restricts to `sprint in openSprints()`, and
   * transparently falls back to all open issues if the instance/project doesn't
   * support the Sprint field (Kanban / Jira Core / Server without Software).
   * Cloud uses /rest/api/3/search/jql; Server/DC uses /rest/api/2/search.
   */
  async getMyOpenIssues(
    signal?: AbortSignal,
    activeSprintOnly = true,
    maxResults = 50
  ): Promise<MyIssuesResult> {
    const path = this.opts.type === "cloud" ? "/rest/api/3/search/jql" : "/rest/api/2/search";
    const fields = ["summary", "issuetype", "status", "priority", "updated"];

    const runQuery = async (jql: string): Promise<JiraIssueSummary[]> => {
      const res = await this.http.post(path, { jql, fields, maxResults }, { signal });
      const issues = res.data?.issues ?? [];
      return issues.map((i: any) => ({
        key: i.key,
        summary: i.fields?.summary ?? "",
        issueType: i.fields?.issuetype?.name ?? "",
        status: i.fields?.status?.name ?? "",
        statusCategory: i.fields?.status?.statusCategory?.key,
        priority: i.fields?.priority?.name,
        updated: i.fields?.updated,
      }));
    };

    try {
      const issues = await runQuery(buildMyIssuesJql(activeSprintOnly));
      return { issues, sprintFilterApplied: activeSprintOnly };
    } catch (err) {
      // If the Sprint field/function isn't available, retry without it.
      if (activeSprintOnly && isSprintUnsupported(err)) {
        try {
          const issues = await runQuery(buildMyIssuesJql(false));
          return { issues, sprintFilterApplied: false };
        } catch (err2) {
          throw this.toFriendlyError(err2, "search");
        }
      }
      throw this.toFriendlyError(err, "search");
    }
  }

  /** Available workflow transitions for an issue. */
  async getTransitions(key: string, signal?: AbortSignal): Promise<JiraTransition[]> {
    try {
      const res = await this.http.get(
        `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
        { signal }
      );
      const list = res.data?.transitions ?? [];
      return list.map((t: any) => ({ id: t.id, name: t.name, toStatus: t.to?.name }));
    } catch (err) {
      throw this.toFriendlyError(err, key);
    }
  }

  private async applyTransition(key: string, transitionId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.http.post(
        `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
        { transition: { id: transitionId } },
        { signal }
      );
    } catch (err) {
      throw this.toFriendlyError(err, key);
    }
  }

  /**
   * Move an issue toward the given target status/transition name.
   * Returns what happened so the caller can report it. Never throws for a
   * missing transition — that's a normal "workflow doesn't allow it" outcome.
   */
  async transitionTo(
    key: string,
    target: string,
    signal?: AbortSignal
  ): Promise<{ applied?: string; skipped?: string }> {
    const transitions = await this.getTransitions(key, signal);
    const chosen = pickTransition(transitions, target);
    if (!chosen) {
      return {
        skipped: `no transition to "${target}" from the current status (available: ${describeTransitions(transitions)})`,
      };
    }
    await this.applyTransition(key, chosen.id, signal);
    return { applied: chosen.toStatus || chosen.name };
  }

  private toFriendlyError(err: unknown, key: string): Error {
    if (axios.isCancel(err)) {
      return new OperationCancelled();
    }
    const ax = err as AxiosError;
    const status = ax.response?.status;
    if (status === 401 || status === 403) {
      return new JiraError(
        "Jira rejected your credentials (401/403). Re-run the setup wizard to update your token.",
        status
      );
    }
    if (status === 404) {
      return new JiraError(`Jira ticket "${key}" was not found (404). Check the key.`, status);
    }
    const code = pickCode(ax);
    const explained = explainNetworkCode(code);
    if (explained) {
      return new JiraError(`Couldn't reach Jira (${code}). ${explained}`);
    }
    return new JiraError(ax.message || "Unknown Jira error", status);
  }
}

/**
 * True when a JQL failure is due to the Sprint field/function being unavailable
 * (so we can retry without the sprint clause). Never matches cancellations.
 */
function isSprintUnsupported(err: unknown): boolean {
  if (axios.isCancel(err)) {
    return false;
  }
  const ax = err as AxiosError<any>;
  if (ax.response?.status !== 400) {
    return false;
  }
  const data = ax.response?.data;
  const parts: string[] = [];
  if (Array.isArray(data?.errorMessages)) {
    parts.push(...data.errorMessages);
  }
  if (data?.errors && typeof data.errors === "object") {
    parts.push(...Object.values(data.errors as Record<string, string>));
  }
  if (typeof data === "string") {
    parts.push(data);
  }
  return /sprint/i.test(parts.join(" "));
}
