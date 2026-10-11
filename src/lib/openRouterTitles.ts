// Pane titles summarized from an agent's first message by an OpenRouter model.
// The chat-completion request is proxied through the Rust backend
// (openRouterChatCompletion in api.ts) so the API key is attached server-side;
// the renderer never sends it and the backend enforces the request timeout.
import { TAB_TITLE_PROVIDER_OPTIONS, type AppSettings } from "./settings";
import { stripTaggedUserInstructionBlocks } from "./taggedInstructions";
import { sanitizeTerminalTitle } from "./terminalTitle";

const MAX_FIRST_MESSAGE_TITLE_CHARS = 80;
const MAX_OPENROUTER_TITLE_SOURCE_CHARS = 4000;
const OPENROUTER_TITLE_MAX_COMPLETION_TOKENS = 1000;
/** Messages examined for a usable title source before a pending title is dropped. */
export const FIRST_MESSAGE_TITLE_LOOKAHEAD_LIMIT = 5;
/** The message the Settings "Test title" button summarizes. */
export const TITLE_GENERATION_TEST_MESSAGE =
  "Review the launch plan, identify the highest-risk blockers, and suggest next steps.";

export interface OpenRouterTitleConfig {
  // The API key is not carried here: the backend proxy reads it from the
  // preferences file.
  model: string;
}

type OpenRouterTitleReasoningEffort = "none" | "minimal";

/** The backend proxy's response: the upstream HTTP status and raw body. */
export type OpenRouterCompletion = (payload: unknown) => Promise<{ status: number; body: string }>;

export function normalizedMessagePreview(rawMessage: string): string | null {
  const normalized = rawMessage
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

/** The text a title is summarized from: the message without tagged
 * instruction blocks, whitespace-normalized; null when nothing remains. */
export function firstMessageTitleSource(rawMessage: string): string | null {
  return normalizedMessagePreview(stripTaggedUserInstructionBlocks(rawMessage));
}

/** A model's reply as a title: one line, without a "Title:" label or
 * surrounding quotes, at most 80 characters. */
export function sanitizeGeneratedTitle(rawTitle: string): string | null {
  const normalized = sanitizeTerminalTitle(rawTitle);
  if (!normalized) {
    return null;
  }
  const withoutLabel = normalized.replace(/^title:\s*/i, "").trim();
  const unquoted = withoutLabel.replace(/^["'`]+|["'`.]+$/g, "").trim();
  if (!unquoted) {
    return null;
  }
  const chars = Array.from(unquoted);
  if (chars.length <= MAX_FIRST_MESSAGE_TITLE_CHARS) {
    return unquoted;
  }

  return `${chars.slice(0, MAX_FIRST_MESSAGE_TITLE_CHARS - 1).join("").trimEnd()}…`;
}

export function firstMessageTitleConfig(
  settings: Pick<AppSettings, "tabTitleProvider" | "openRouterKey" | "openRouterModel">,
): OpenRouterTitleConfig | null {
  if (settings.tabTitleProvider !== "openRouter") {
    return null;
  }
  // OpenRouter sends first-message text to a third-party service, so selecting the
  // provider is the consent boundary; a configured key and model are still required
  // to make a call. The key stays out of the returned config — the backend proxy
  // attaches it — but its presence still gates whether a request is attempted.
  const hasKey = settings.openRouterKey.trim().length > 0;
  const model = settings.openRouterModel.trim();
  return hasKey && model ? { model } : null;
}

export function tabTitleProviderLabel(provider: AppSettings["tabTitleProvider"]): string {
  return (
    TAB_TITLE_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? "Tab titles"
  );
}

/** A pane whose title waits for its agent's first usable message. */
export interface PendingFirstMessageTitle {
  paneId: string;
  checkedMessages: number;
}

/** Applies one submitted message to a pending title: `pending` is what to
 * keep waiting with (null stops waiting), and `sourceMessage` is the text to
 * summarize when a title should be generated now. */
export function advancePendingFirstMessageTitle(
  pending: PendingFirstMessageTitle,
  rawMessage: string,
  titleConfig: OpenRouterTitleConfig | null,
): { pending: PendingFirstMessageTitle | null; sourceMessage: string | null } {
  if (!normalizedMessagePreview(rawMessage)) {
    return { pending, sourceMessage: null };
  }
  const checked = { ...pending, checkedMessages: pending.checkedMessages + 1 };
  const sourceMessage = firstMessageTitleSource(rawMessage);
  if (!sourceMessage) {
    return {
      pending: checked.checkedMessages >= FIRST_MESSAGE_TITLE_LOOKAHEAD_LIMIT ? null : checked,
      sourceMessage: null,
    };
  }
  return { pending: null, sourceMessage: titleConfig ? sourceMessage : null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function openRouterPayloadErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    return payload.trim() || null;
  }
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  const error = record.error;
  if (typeof error === "string") {
    return error;
  }
  const errorRecord = asRecord(error);
  return typeof errorRecord?.message === "string" ? errorRecord.message : null;
}

function openRouterContentText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const partRecord = asRecord(part);
      const text = partRecord?.text;
      if (typeof text === "string") {
        return text;
      }
      const nestedContent = partRecord?.content;
      return typeof nestedContent === "string" ? nestedContent : "";
    })
    .join("");
  return text.trim() ? text : null;
}

function openRouterFirstChoice(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  return asRecord(choices[0]);
}

export function openRouterTitleFromPayload(payload: unknown): string | null {
  const firstChoice = openRouterFirstChoice(payload);
  const message = asRecord(firstChoice?.message);
  const content = message?.content ?? firstChoice?.text;
  const text = openRouterContentText(content);
  return text ? sanitizeGeneratedTitle(text) : null;
}

function openRouterChoiceErrorMessage(choice: Record<string, unknown> | null): string | null {
  const error = asRecord(choice?.error);
  if (!error) {
    return null;
  }
  const message = typeof error.message === "string" ? error.message : "Unknown provider error";
  const code =
    typeof error.code === "string" || typeof error.code === "number" ? ` ${error.code}` : "";
  return `choice error${code}: ${message}`;
}

function openRouterPayloadUsageSummary(payload: unknown): string | null {
  const record = asRecord(payload);
  const usage = asRecord(record?.usage);
  if (!usage) {
    return null;
  }
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
  const completionDetails = asRecord(usage.completion_tokens_details);
  const reasoningTokens =
    typeof completionDetails?.reasoning_tokens === "number"
      ? completionDetails.reasoning_tokens
      : null;
  const parts: string[] = [];
  if (completionTokens !== null) {
    parts.push(`completion_tokens=${completionTokens}`);
  }
  if (reasoningTokens !== null) {
    parts.push(`reasoning_tokens=${reasoningTokens}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export function openRouterEmptyTitleMessage(payload: unknown): string {
  const firstChoice = openRouterFirstChoice(payload);
  const choiceError = openRouterChoiceErrorMessage(firstChoice);
  if (choiceError) {
    return `OpenRouter generation failed: ${choiceError}`;
  }

  const finishReason =
    typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null;
  const nativeFinishReason =
    typeof firstChoice?.native_finish_reason === "string"
      ? firstChoice.native_finish_reason
      : null;
  const usage = openRouterPayloadUsageSummary(payload);
  const details: string[] = [];
  if (finishReason) {
    details.push(`finish_reason=${finishReason}`);
  }
  if (nativeFinishReason && nativeFinishReason !== finishReason) {
    details.push(`native_finish_reason=${nativeFinishReason}`);
  }
  if (usage) {
    details.push(usage);
  }

  return details.length > 0
    ? `OpenRouter returned no title (${details.join(", ")}).`
    : "OpenRouter returned no title.";
}

function isOpenRouterReasoningConfigError(status: number, message: string | null): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  return /\b(reasoning|effort|thinking)\b/i.test(message ?? "");
}

export function openRouterTitlePayload(
  sourceMessage: string,
  titleConfig: OpenRouterTitleConfig,
  reasoningEffort: OpenRouterTitleReasoningEffort | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: titleConfig.model,
    messages: [
      {
        role: "system",
        content:
          "Create a concise terminal tab title for the user's first message. Return only the title, without quotes. Use 2-6 words. Use sentence case, not title case.",
      },
      {
        role: "user",
        content: Array.from(sourceMessage).slice(0, MAX_OPENROUTER_TITLE_SOURCE_CHARS).join(""),
      },
    ],
    temperature: 0.2,
    max_completion_tokens: OPENROUTER_TITLE_MAX_COMPLETION_TOKENS,
    stream: false,
  };
  if (reasoningEffort) {
    payload.reasoning = {
      effort: reasoningEffort,
      exclude: true,
    };
  }
  return payload;
}

function parseOpenRouterBody(raw: string, ok: boolean): unknown {
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (ok) {
      throw new Error("OpenRouter returned invalid JSON.");
    }
    return raw;
  }
}

/** Requests a title for `sourceMessage`. A 400/422 that names the reasoning
 * setting retries with `minimal` reasoning effort, then with none set. */
export async function summarizeFirstMessageTitle(
  sourceMessage: string,
  titleConfig: OpenRouterTitleConfig,
  complete: OpenRouterCompletion,
): Promise<string | null> {
  const attempts: (OpenRouterTitleReasoningEffort | null)[] = ["none", "minimal", null];
  for (let index = 0; index < attempts.length; index += 1) {
    const reasoningEffort = attempts[index];
    const payload = openRouterTitlePayload(sourceMessage, titleConfig, reasoningEffort);
    const { status, body } = await complete(payload);
    const ok = status >= 200 && status < 300;
    const responsePayload = parseOpenRouterBody(body, ok);
    if (!ok) {
      const message = openRouterPayloadErrorMessage(responsePayload) ?? `HTTP ${status}`;
      if (index < attempts.length - 1 && isOpenRouterReasoningConfigError(status, message)) {
        continue;
      }
      throw new Error(`OpenRouter request failed (${status}): ${message}`);
    }

    const payloadError = openRouterPayloadErrorMessage(responsePayload);
    if (payloadError) {
      throw new Error(`OpenRouter returned an error: ${payloadError}`);
    }
    const title = openRouterTitleFromPayload(responsePayload);
    if (!title) {
      throw new Error(openRouterEmptyTitleMessage(responsePayload));
    }
    return title;
  }
  return null;
}
