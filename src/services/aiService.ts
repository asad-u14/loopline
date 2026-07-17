import {
  MrPromptInput,
  PlanPromptInput,
  TicketCheckPromptInput,
  StandupPromptInput,
} from "../util/ai-prompt";

/** Common surface both AI providers (Anthropic direct, OpenAI-compatible gateway) implement. */
export interface AiService {
  verify(signal?: AbortSignal): Promise<void>;
  generateMrDescription(input: MrPromptInput, signal?: AbortSignal): Promise<string>;
  generateImplementationPlan(input: PlanPromptInput, signal?: AbortSignal): Promise<string>;
  checkDiffAgainstTicket(input: TicketCheckPromptInput, signal?: AbortSignal): Promise<string>;
  generateStandupSummary(input: StandupPromptInput, signal?: AbortSignal): Promise<string>;
}
