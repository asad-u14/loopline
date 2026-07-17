import OpenAI from "openai";
import { OperationCancelled } from "../util/progress";
import { buildFetchDispatcher, describePlan, explainNetworkCode, HttpOptions } from "../util/http";
import { log, logError } from "../util/log";
import { AiService } from "./aiService";
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
  StandupPromptInput,
  STANDUP_SYSTEM_PROMPT,
  buildStandupUserPrompt,
} from "../util/ai-prompt";

/** Any OpenAI-Chat-Completions-compatible endpoint — e.g. an internal AI gateway in front of Bedrock/Azure/etc. */
export interface OpenAiGatewayOptions {
  apiKey: string;
  baseUrl: string; // e.g. https://api-eu1.aigateway.example.com/v1 — no public default, must be configured
  model: string;
  maxDiffBytes: number;
  timeoutMs?: number;
  http?: HttpOptions;
}

export class OpenAiGatewayError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "OpenAiGatewayError";
  }
}

export class OpenAiGatewayService implements AiService {
  private client: OpenAI;

  constructor(private opts: OpenAiGatewayOptions) {
    const baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const { dispatcher, plan } = buildFetchDispatcher(baseUrl, opts.http ?? {});
    log(`AI Gateway network: ${describePlan(plan)} (base=${baseUrl})`);
    if (plan.insecure) {
      logError("AI Gateway: TLS verification is disabled via loopline.http.allowInsecureTls — insecure, use only as a temporary workaround.");
    }
    const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: opts.apiKey,
      baseURL: baseUrl,
      timeout: opts.timeoutMs ?? 45000,
    };
    if (dispatcher) {
      // `undici`'s own Dispatcher type and the one bundled in @types/node (via
      // `undici-types`) are structurally identical but nominally distinct, so this
      // needs a cast — see https://github.com/nodejs/undici/issues/2967.
      (clientOptions as { fetchOptions?: unknown }).fetchOptions = { dispatcher };
    }
    this.client = new OpenAI(clientOptions);
  }

  /** Minimal call to confirm the key/model/endpoint work (costs ~1 output token). */
  async verify(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.chat.completions.create(
        { model: this.opts.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
        { signal }
      );
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  async generateMrDescription(input: MrPromptInput, signal?: AbortSignal): Promise<string> {
    return this.complete(MR_SYSTEM_PROMPT, buildMrUserPrompt(input, this.opts.maxDiffBytes), 1024, signal);
  }

  async generateImplementationPlan(input: PlanPromptInput, signal?: AbortSignal): Promise<string> {
    return this.complete(PLAN_SYSTEM_PROMPT, buildPlanUserPrompt(input), 1500, signal);
  }

  /** Checks whether a diff appears to address a Jira ticket's stated requirements. */
  async checkDiffAgainstTicket(input: TicketCheckPromptInput, signal?: AbortSignal): Promise<string> {
    return this.complete(
      TICKET_CHECK_SYSTEM_PROMPT,
      buildTicketCheckUserPrompt(input, this.opts.maxDiffBytes),
      500,
      signal
    );
  }

  /** Drafts a standup update from today's commits, grouped by ticket. */
  async generateStandupSummary(input: StandupPromptInput, signal?: AbortSignal): Promise<string> {
    return this.complete(STANDUP_SYSTEM_PROMPT, buildStandupUserPrompt(input), 700, signal);
  }

  private async complete(
    system: string,
    userPrompt: string,
    maxTokens: number,
    signal?: AbortSignal
  ): Promise<string> {
    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.opts.model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userPrompt },
          ],
        },
        { signal }
      );
      const text = (res.choices?.[0]?.message?.content ?? "").trim();
      if (!text) {
        throw new OpenAiGatewayError("The model returned an empty response.");
      }
      return text;
    } catch (err) {
      throw this.toFriendlyError(err);
    }
  }

  private toFriendlyError(err: unknown): Error {
    if (err instanceof OpenAiGatewayError) {
      return err;
    }
    if (err instanceof OpenAI.APIUserAbortError) {
      return new OperationCancelled();
    }
    // Network-level failures (no HTTP response at all) come back as APIConnectionError,
    // which — being a subclass of APIError with status=undefined — must be handled
    // before the generic APIError branch below.
    if (err instanceof OpenAI.APIConnectionError) {
      // undici wraps the real Node error two levels down: APIConnectionError.cause is
      // fetch's own "TypeError: fetch failed", whose .cause is the actual ECONNREFUSED/etc.
      const code = findCauseCode(err);
      const explained = explainNetworkCode(code);
      return new OpenAiGatewayError(
        explained
          ? `Couldn't reach the AI gateway endpoint (${code}). ${explained}`
          : err.message || "Couldn't reach the AI gateway endpoint."
      );
    }
    if (err instanceof OpenAI.APIError) {
      const status = err.status;
      // err.message is prefixed with the status code ("401 invalid key"); the parsed
      // body's own message field is the clean text the gateway actually sent.
      const apiMsg = (err.error as { message?: string } | undefined)?.message ?? err.message;
      if (status === 401) {
        return new OpenAiGatewayError(
          "The AI gateway rejected the API key (401). Set it again via 'Loopline: Set AI (OpenAI Gateway) API Key'.",
          status
        );
      }
      if (status === 403) {
        const reason = apiMsg ? ` The gateway said: "${apiMsg}"` : "";
        return new OpenAiGatewayError(
          `The AI gateway rejected the request (403) — the key is valid but not permitted.${reason} Check that the key has access to the configured model (\`loopline.ai.model\`).`,
          status
        );
      }
      if (status === 400 && /model/i.test(apiMsg || "")) {
        return new OpenAiGatewayError(`Model not accepted: ${apiMsg}. Check \`loopline.ai.model\`.`, status);
      }
      if (status === 404) {
        return new OpenAiGatewayError("Endpoint not found (404). Check `loopline.ai.baseUrl`.", status);
      }
      if (status === 429) {
        return new OpenAiGatewayError("Rate limited by the AI gateway (429). Try again shortly.", status);
      }
      return new OpenAiGatewayError(apiMsg || "Unknown AI gateway error", status);
    }
    const code = findCauseCode(err);
    const explained = explainNetworkCode(code);
    if (explained) {
      return new OpenAiGatewayError(`Couldn't reach the AI gateway endpoint (${code}). ${explained}`);
    }
    return new OpenAiGatewayError((err as Error)?.message || "Unknown AI gateway error");
  }
}

/** Walks a chained `.cause` (fetch wraps the real Node error a level or two down) for the first `.code`. */
function findCauseCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown })?.code;
    if (typeof code === "string") {
      return code;
    }
    cur = (cur as { cause?: unknown })?.cause;
  }
  return undefined;
}
