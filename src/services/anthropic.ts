import axios, { AxiosInstance, AxiosError } from "axios";
import { OperationCancelled } from "../util/progress";
import { createHttpClient, pickCode } from "../util/http-client";
import { explainNetworkCode, HttpOptions } from "../util/http";
import {
  MrPromptInput,
  MR_SYSTEM_PROMPT,
  buildMrUserPrompt,
  PlanPromptInput,
  PLAN_SYSTEM_PROMPT,
  buildPlanUserPrompt,
  TicketCheckPromptInput,
  TICKET_CHECK_SYSTEM_PROMPT,
  buildTicketCheckUserPrompt,
} from "../util/ai-prompt";

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;   // default https://api.anthropic.com
  model: string;
  maxDiffBytes: number;
  timeoutMs?: number;
  http?: HttpOptions;
}

export class AnthropicError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "AnthropicError";
  }
}

export class AnthropicService {
  private http: AxiosInstance;

  constructor(private opts: AnthropicOptions) {
    this.http = createHttpClient({
      label: "Anthropic",
      baseUrl: (opts.baseUrl || "https://api.anthropic.com").replace(/\/+$/, ""),
      timeoutMs: opts.timeoutMs ?? 45000,
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      http: opts.http,
    });
  }

  /** Minimal call to confirm the key/model/endpoint work (costs ~1 output token). */
  async verify(signal?: AbortSignal): Promise<void> {
    try {
      await this.http.post(
        "/v1/messages",
        { model: this.opts.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
        { signal }
      );
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  async generateMrDescription(input: MrPromptInput, signal?: AbortSignal): Promise<string> {
    const userPrompt = buildMrUserPrompt(input, this.opts.maxDiffBytes);
    try {
      const res = await this.http.post(
        "/v1/messages",
        {
          model: this.opts.model,
          max_tokens: 1024,
          system: MR_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        },
        { signal }
      );
      const text = extractText(res.data);
      if (!text.trim()) {
        throw new AnthropicError("The model returned an empty response.");
      }
      return text.trim();
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  async generateImplementationPlan(input: PlanPromptInput, signal?: AbortSignal): Promise<string> {
    const userPrompt = buildPlanUserPrompt(input);
    try {
      const res = await this.http.post(
        "/v1/messages",
        {
          model: this.opts.model,
          max_tokens: 1500,
          system: PLAN_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        },
        { signal }
      );
      const text = extractText(res.data);
      if (!text.trim()) {
        throw new AnthropicError("The model returned an empty response.");
      }
      return text.trim();
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  /** Checks whether a diff appears to address a Jira ticket's stated requirements. */
  async checkDiffAgainstTicket(input: TicketCheckPromptInput, signal?: AbortSignal): Promise<string> {
    const userPrompt = buildTicketCheckUserPrompt(input, this.opts.maxDiffBytes);
    try {
      const res = await this.http.post(
        "/v1/messages",
        {
          model: this.opts.model,
          max_tokens: 500,
          system: TICKET_CHECK_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        },
        { signal }
      );
      const text = extractText(res.data);
      if (!text.trim()) {
        throw new AnthropicError("The model returned an empty response.");
      }
      return text.trim();
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  private toFriendlyError(err: unknown): Error {
    if (axios.isCancel(err)) {
      return new OperationCancelled();
    }
    if (err instanceof AnthropicError) {
      return err;
    }
    const ax = err as AxiosError<any>;
    const status = ax.response?.status;
    const apiMsg = ax.response?.data?.error?.message;
    if (status === 401) {
      return new AnthropicError("Anthropic rejected the API key (401). Set it again via 'Loopline: Set AI (Anthropic) API Key'.", status);
    }
    if (status === 403) {
      return new AnthropicError(
        "Anthropic rejected the request (403) — the key is valid but not permitted. Usually this means the Console organization has no billing/credits set up, the key was created in the wrong workspace, or a proxy/firewall between you and api.anthropic.com is blocking or rewriting the request. Check console.anthropic.com, and if you're behind a proxy set `loopline.http.proxy`.",
        status
      );
    }
    if (status === 400 && typeof apiMsg === "string" && /model/i.test(apiMsg)) {
      return new AnthropicError(`Model not accepted: ${apiMsg}. Check \`loopline.ai.model\`.`, status);
    }
    if (status === 404) {
      return new AnthropicError("Endpoint not found (404). Check `loopline.ai.baseUrl`.", status);
    }
    if (status === 429) {
      return new AnthropicError("Rate limited by Anthropic (429). Try again shortly.", status);
    }
    const code = pickCode(ax);
    const explained = explainNetworkCode(code);
    if (explained) {
      return new AnthropicError(`Couldn't reach the Anthropic endpoint (${code}). ${explained}`);
    }
    return new AnthropicError(apiMsg || ax.message || "Unknown Anthropic error", status);
  }
}

/** The Messages API returns content as an array of blocks; join the text ones. */
function extractText(data: any): string {
  const blocks = data?.content;
  if (!Array.isArray(blocks)) {
    return "";
  }
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}
