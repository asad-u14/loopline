import axios, { AxiosInstance, AxiosError } from "axios";
import { OperationCancelled } from "../util/progress";
import { createHttpClient, pickCode } from "../util/http-client";
import { explainNetworkCode, HttpOptions } from "../util/http";

export interface GitLabMR {
  iid: number;
  web_url: string;
  title: string;
  source_branch: string;
  target_branch: string;
}

export interface CreateMROptions {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  removeSourceBranch?: boolean;
  draft?: boolean;
}

export class GitLabError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "GitLabError";
  }
}

export class GitLabService {
  private http: AxiosInstance;

  constructor(host: string, token: string, timeoutMs = 15000, http?: HttpOptions) {
    this.http = createHttpClient({
      label: "GitLab",
      baseUrl: `${host.replace(/\/+$/, "")}/api/v4`,
      timeoutMs,
      headers: { "PRIVATE-TOKEN": token },
      http,
    });
  }

  /** GitLab accepts a numeric id or URL-encoded "namespace/path" as :id. */
  private encodeProject(project: string): string {
    return /^\d+$/.test(project) ? project : encodeURIComponent(project);
  }

  /**
   * Confirm the token authenticates. `/user` gives a friendly username, but it's
   * commonly forbidden (403) for group/project access tokens or narrow scopes even
   * though the token can still create MRs. So: 401 = bad token (fail); 403 = the
   * token authenticated but that endpoint is restricted — fall back to /version,
   * and failing that accept it (MR scope is validated when actually creating an MR).
   */
  async verify(signal?: AbortSignal): Promise<string> {
    try {
      const res = await this.http.get("/user", { signal });
      return res.data?.username || res.data?.name || "GitLab user";
    } catch (err) {
      if (axios.isCancel(err)) {
        throw new OperationCancelled();
      }
      const ax = err as AxiosError<any>;
      const status = ax.response?.status;
      if (status === 401) {
        throw new GitLabError("GitLab rejected your token (401). It's wrong or expired.", 401);
      }
      if (status === 403) {
        // Authenticated but /user is restricted — confirm via a lighter endpoint.
        try {
          const v = await this.http.get("/version", { signal });
          const version = v.data?.version ? ` ${v.data.version}` : "";
          return `GitLab${version} (token OK)`;
        } catch (err2) {
          if (axios.isCancel(err2)) {
            throw new OperationCancelled();
          }
          const s2 = (err2 as AxiosError).response?.status;
          if (s2 === 401) {
            throw new GitLabError("GitLab rejected your token (401). It's wrong or expired.", 401);
          }
          // Still authenticated (403) — accept; MR scope is checked when creating one.
          return "GitLab (token accepted — ensure it has 'api' scope for merge requests)";
        }
      }
      if (status === 404) {
        throw new GitLabError("Reached the host but the API was 404 — check the GitLab host URL.", 404);
      }
      const code = pickCode(ax);
      const explained = explainNetworkCode(code);
      if (explained) {
        throw new GitLabError(`Couldn't reach GitLab (${code}). ${explained}`);
      }
      throw new GitLabError(ax.message || "Unknown GitLab error", status);
    }
  }

  async findOpenMR(project: string, sourceBranch: string, signal?: AbortSignal): Promise<GitLabMR | undefined> {
    try {
      const res = await this.http.get(
        `/projects/${this.encodeProject(project)}/merge_requests`,
        { params: { state: "opened", source_branch: sourceBranch }, signal }
      );
      const list = res.data as GitLabMR[];
      return Array.isArray(list) && list.length > 0 ? list[0] : undefined;
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  async createMR(project: string, opts: CreateMROptions, signal?: AbortSignal): Promise<GitLabMR> {
    try {
      const title = opts.draft ? `Draft: ${opts.title}` : opts.title;
      const res = await this.http.post(
        `/projects/${this.encodeProject(project)}/merge_requests`,
        {
          source_branch: opts.sourceBranch,
          target_branch: opts.targetBranch,
          title,
          description: opts.description,
          remove_source_branch: opts.removeSourceBranch ?? true,
        },
        { signal }
      );
      return res.data as GitLabMR;
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  private toFriendlyError(err: unknown): Error {
    if (axios.isCancel(err)) {
      return new OperationCancelled();
    }
    const ax = err as AxiosError<any>;
    const status = ax.response?.status;
    if (status === 401) {
      return new GitLabError(
        "GitLab rejected your token (401). Re-run setup to update it.",
        status
      );
    }
    if (status === 403) {
      return new GitLabError(
        "GitLab denied the request (403). The token needs 'api' scope and you need at least Developer access to the project.",
        status
      );
    }
    if (status === 404) {
      return new GitLabError(
        "GitLab project not found (404). Set `loopline.gitlab.projectId` or check the origin remote.",
        status
      );
    }
    const code = pickCode(ax);
    const explained = explainNetworkCode(code);
    if (explained) {
      return new GitLabError(`Couldn't reach GitLab (${code}). ${explained}`);
    }
    const serverMsg =
      ax.response?.data?.message || ax.response?.data?.error || ax.message;
    return new GitLabError(
      typeof serverMsg === "string" ? serverMsg : "Unknown GitLab error",
      status
    );
  }
}
