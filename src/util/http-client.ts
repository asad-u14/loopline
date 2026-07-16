import axios, { AxiosInstance, AxiosError } from "axios";
import { log, logError } from "./log";
import {
  buildHttpConfig,
  describePlan,
  explainNetworkCode,
  HttpOptions,
  HttpPlan,
} from "./http";

export interface ClientOptions {
  label: string; // "Jira" | "GitLab" | "Anthropic" — used in logs
  baseUrl: string;
  timeoutMs: number;
  headers: Record<string, string>;
  http?: HttpOptions;
}

/**
 * Build an axios instance with corporate-network handling (proxy + extra CAs)
 * and logging of every request/failure — including the raw Node error code, which
 * is what distinguishes a proxy problem from a TLS-trust problem.
 */
export function createHttpClient(opts: ClientOptions): AxiosInstance {
  const { config, plan } = buildHttpConfig(opts.baseUrl, opts.http ?? {});

  const instance = axios.create({
    baseURL: opts.baseUrl,
    timeout: opts.timeoutMs,
    headers: opts.headers,
    ...config,
  });

  logPlanOnce(opts.label, opts.baseUrl, plan);

  instance.interceptors.request.use((req) => {
    (req as { __start?: number }).__start = Date.now();
    log(`${opts.label} → ${(req.method || "get").toUpperCase()} ${joinUrl(req.baseURL, req.url)}`);
    return req;
  });

  instance.interceptors.response.use(
    (res) => {
      const ms = elapsed(res.config as { __start?: number });
      log(`${opts.label} ← ${res.status} ${joinUrl(res.config.baseURL, res.config.url)}${ms}`);
      return res;
    },
    (err: AxiosError) => {
      if (axios.isCancel(err)) {
        log(`${opts.label} ✕ request cancelled`);
        return Promise.reject(err);
      }
      const url = joinUrl(err.config?.baseURL, err.config?.url);
      const status = err.response?.status;
      const code = pickCode(err);
      const bits = [
        status ? `HTTP ${status}` : undefined,
        code ? `code=${code}` : undefined,
        err.message,
      ]
        .filter(Boolean)
        .join(" | ");
      logError(`${opts.label} ✕ ${url} — ${bits}`);
      const hint = explainNetworkCode(code);
      if (hint) {
        log(`${opts.label}   hint: ${hint}`);
      }
      return Promise.reject(err);
    }
  );

  return instance;
}

const planned = new Set<string>();

/** Log the networking plan once per label+baseUrl, so logs aren't noisy. */
function logPlanOnce(label: string, baseUrl: string, plan: HttpPlan): void {
  const key = `${label}|${baseUrl}|${describePlan(plan)}`;
  if (planned.has(key)) {
    return;
  }
  planned.add(key);
  log(`${label} network: ${describePlan(plan)} (base=${baseUrl})`);
  plan.caProblems.forEach((p) => logError(`${label} CA: ${p}`));
  if (plan.insecure) {
    logError(`${label}: TLS verification is disabled via loopline.http.allowInsecureTls — insecure, use only as a temporary workaround.`);
  }
}

/** Reset memoized plan logging (used when settings change). */
export function resetHttpPlanLog(): void {
  planned.clear();
}

/**
 * Extract the most useful low-level code: axios' own code, or the underlying
 * TLS/socket error code, which axios nests on `err.cause`.
 */
export function pickCode(err: AxiosError): string | undefined {
  const direct = err.code;
  const cause = (err as unknown as { cause?: { code?: string } }).cause?.code;
  // TLS codes on the cause are more specific than a generic axios code.
  if (cause && (!direct || direct === "ERR_BAD_REQUEST" || direct === "ERR_BAD_RESPONSE")) {
    return cause;
  }
  return direct ?? cause;
}

function joinUrl(base: string | undefined, url: string | undefined): string {
  if (!url) {
    return base ?? "";
  }
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${(base ?? "").replace(/\/+$/, "")}${url}`;
}

function elapsed(cfg: { __start?: number } | undefined): string {
  const start = cfg?.__start;
  return start ? ` (${Date.now() - start}ms)` : "";
}
