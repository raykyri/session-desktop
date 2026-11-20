// Billing at spend time (`03-agents-and-research.md` K1, E5).
//
// `AttemptMeter.wrap` puts a model behind a ledger: every `doStream` and
// `doGenerate` is one provider call and one ledger row. The row opens when
// the call starts, with the input tokens estimated from the request; while
// the call streams, its output tokens are estimated from the streamed text
// and written at most every `checkpointMs`; when the call ends it closes:
//
// - with the provider's own counts on the call's `finish` part;
// - at 0 when the provider refused the call before streaming (an HTTP error,
//   a 429 among them);
// - with the last counts (the request's input, the output streamed so far)
//   when the stream errors, or when its abort signal fires, whatever aborted
//   it: cancel, timeout, drain, the attempt fence, the overdraft limit or the
//   run's token cap. `MeterHooks.abortEnding` says which.
//
// The provider stream protocol (`LanguageModelV4StreamPart`) reports usage
// only on `finish`, so the output counts of an unfinished call are an
// estimate: the shared `estimateTokenCount` over the text, reasoning and tool
// input the call streamed. Once the call's row is closed by an abort, no
// further part is passed on, so what the run commits is what was billed.

import { APICallError } from "@ai-sdk/provider";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { ModelEntry } from "@session/shared";
import { estimateTokenCount } from "@session/shared";

import type { CallEnding, CallKind, Ledger, LedgerCounts, Payer } from "./ledger.js";
import { ZERO_COUNTS, cachedInputRatio, weekOf } from "./ledger.js";

export interface MeterDeps {
  ledger: Ledger;
  now: () => number;
  /** `LEDGER_CHECKPOINT_MS` outside tests. */
  checkpointMs: number;
}

/** Whose calls the meter records. */
export interface MeterScope {
  runId: string;
  attempt: number;
  userId: string;
}

/** What one wrapped model bills. */
export interface MeteredModel {
  entry: ModelEntry;
  payer: Payer;
  kind: CallKind;
}

export interface MeterHooks {
  /** How a call whose abort signal fired ended. Read when it fires, so the
   * caller sets the reason before it aborts. */
  abortEnding: () => CallEnding;
  /** After each checkpoint of a streaming call: where the overdraft limit
   * and the run's token cap are checked (`03` K9, L1). */
  onCheckpoint?: (payer: Payer) => void;
}

/** A closed call's raw counts, summed for the attempt's summary. */
export interface MeterTotals extends LedgerCounts {
  calls: number;
}

function promptText(prompt: LanguageModelV4Prompt): string {
  const parts: string[] = [];
  for (const message of prompt) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") {
        parts.push(part.text);
      } else {
        parts.push(JSON.stringify(part));
      }
    }
  }
  return parts.join("\n");
}

/** Input tokens as counted for a request, before the provider counts them:
 * the prompt and the tool definitions. */
export function estimateInputTokens(options: LanguageModelV4CallOptions): number {
  const tools = options.tools && options.tools.length > 0 ? JSON.stringify(options.tools) : "";
  return estimateTokenCount(promptText(options.prompt)) + estimateTokenCount(tools);
}

function countsOfUsage(usage: LanguageModelV4Usage, fallback: LedgerCounts): LedgerCounts {
  return {
    inputTokens: usage.inputTokens.total ?? fallback.inputTokens,
    outputTokens: usage.outputTokens.total ?? fallback.outputTokens,
    reasoningTokens: usage.outputTokens.reasoning ?? fallback.reasoningTokens,
    cachedTokens: usage.inputTokens.cacheRead ?? fallback.cachedTokens,
  };
}

function refusalEnding(error: unknown): CallEnding {
  return APICallError.isInstance(error) && error.statusCode === 429 ? "rate_limited" : "error";
}

class OpenCall {
  readonly #meter: AttemptMeter;
  readonly #id: string;
  readonly #input: number;
  #output = "";
  #reasoning = "";
  readonly #toolInputs = new Set<string>();
  #lastCheckpointAt: number;
  #ending: CallEnding | null = null;

  constructor(meter: AttemptMeter, id: string, input: number, openedAt: number) {
    this.#meter = meter;
    this.#id = id;
    this.#input = input;
    this.#lastCheckpointAt = openedAt;
  }

  get id(): string {
    return this.#id;
  }

  get ending(): CallEnding | null {
    return this.#ending;
  }

  /** Closed by anything but the provider's `finish`. */
  get stopped(): boolean {
    return this.#ending !== null && this.#ending !== "finish";
  }

  /** The request's input and the output streamed so far. */
  live(): LedgerCounts {
    return {
      inputTokens: this.#input,
      outputTokens: this.#output === "" ? 0 : estimateTokenCount(this.#output),
      reasoningTokens: this.#reasoning === "" ? 0 : estimateTokenCount(this.#reasoning),
      cachedTokens: 0,
    };
  }

  /** The input estimate with no output: a call aborted before it streamed. */
  inputOnly(): LedgerCounts {
    return { ...ZERO_COUNTS, inputTokens: this.#input };
  }

  observe(part: LanguageModelV4StreamPart): void {
    if (this.#ending !== null) {
      return;
    }
    switch (part.type) {
      case "text-delta":
        this.#output += part.delta;
        break;
      case "reasoning-delta":
        this.#output += part.delta;
        this.#reasoning += part.delta;
        break;
      case "tool-input-delta":
        this.#toolInputs.add(part.id);
        this.#output += part.delta;
        break;
      case "tool-call":
        if (!this.#toolInputs.has(part.toolCallId)) {
          this.#output += part.input;
        }
        break;
      case "finish":
        this.close(countsOfUsage(part.usage, this.live()), "finish");
        break;
      case "error":
        this.close(this.live(), "error");
        break;
      default:
        break;
    }
  }

  /** Writes a checkpoint when `checkpointMs` passed since the last one.
   * True when it wrote. */
  checkpoint(): boolean {
    if (this.#ending !== null) {
      return false;
    }
    const at = this.#meter.deps.now();
    if (at - this.#lastCheckpointAt < this.#meter.deps.checkpointMs) {
      return false;
    }
    this.#lastCheckpointAt = at;
    this.#meter.deps.ledger.checkpoint(this.#id, this.live(), at);
    return true;
  }

  close(counts: LedgerCounts, ending: CallEnding): void {
    if (this.#ending !== null) {
      return;
    }
    this.#ending = ending;
    this.#meter.closed(this, counts, ending);
  }
}

/** The ledger rows of one attempt's provider calls. */
export class AttemptMeter {
  readonly deps: MeterDeps;
  readonly scope: MeterScope;
  readonly hooks: MeterHooks;
  readonly #open = new Set<OpenCall>();
  readonly #payers = new Set<Payer>();
  readonly #totals: MeterTotals = { ...ZERO_COUNTS, calls: 0 };

  constructor(deps: MeterDeps, scope: MeterScope, hooks: MeterHooks) {
    this.deps = deps;
    this.scope = scope;
    this.hooks = hooks;
  }

  /** The payers of the calls made so far, in order of first use. */
  get payers(): ReadonlySet<Payer> {
    return this.#payers;
  }

  get totals(): Readonly<MeterTotals> {
    return this.#totals;
  }

  /** `model` with every call recorded in the ledger as `call`. */
  wrap(model: LanguageModelV4, call: MeteredModel): LanguageModelV4 {
    return {
      specificationVersion: model.specificationVersion,
      provider: model.provider,
      modelId: model.modelId,
      supportedUrls: model.supportedUrls,
      doGenerate: (options) => this.#generate(model, call, options),
      doStream: (options) => this.#stream(model, call, options),
    };
  }

  /** Closes every call still open with its last counts. The loop calls it
   * when the attempt ends, so no path leaves a row open. */
  closeOpen(ending: CallEnding): void {
    for (const call of [...this.#open]) {
      call.close(call.live(), ending);
    }
  }

  /** Called by `OpenCall.close`. */
  closed(call: OpenCall, counts: LedgerCounts, ending: CallEnding): void {
    this.#open.delete(call);
    this.deps.ledger.close(call.id, counts, ending, this.deps.now());
    this.#totals.inputTokens += counts.inputTokens;
    this.#totals.outputTokens += counts.outputTokens;
    this.#totals.reasoningTokens += counts.reasoningTokens;
    this.#totals.cachedTokens += counts.cachedTokens;
    this.#totals.calls += 1;
  }

  #begin(model: MeteredModel, options: LanguageModelV4CallOptions): OpenCall {
    const openedAt = this.deps.now();
    const input = estimateInputTokens(options);
    const id = this.deps.ledger.open({
      runId: this.scope.runId,
      attempt: this.scope.attempt,
      userId: this.scope.userId,
      payer: model.payer,
      week: weekOf(openedAt),
      kind: model.kind,
      provider: model.entry.provider,
      model: model.entry.id,
      cachedInputRatio: cachedInputRatio(model.entry),
      counts: { ...ZERO_COUNTS, inputTokens: input },
      openedAt,
    });
    this.#payers.add(model.payer);
    const call = new OpenCall(this, id, input, openedAt);
    this.#open.add(call);
    return call;
  }

  /** A call that never produced a stream: refused by the provider (closed at
   * 0) or aborted while waiting for it (the request's input, no output). */
  #refused(call: OpenCall, error: unknown, signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      call.close(call.inputOnly(), this.hooks.abortEnding());
    } else {
      call.close(ZERO_COUNTS, refusalEnding(error));
    }
  }

  async #generate(
    model: LanguageModelV4,
    metered: MeteredModel,
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const call = this.#begin(metered, options);
    try {
      const result = await model.doGenerate(options);
      call.close(countsOfUsage(result.usage, call.inputOnly()), "finish");
      return result;
    } catch (error) {
      this.#refused(call, error, options.abortSignal);
      throw error;
    }
  }

  async #stream(
    model: LanguageModelV4,
    metered: MeteredModel,
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const call = this.#begin(metered, options);
    let result: LanguageModelV4StreamResult;
    try {
      result = await model.doStream(options);
    } catch (error) {
      this.#refused(call, error, options.abortSignal);
      throw error;
    }

    const signal = options.abortSignal;
    const hooks = this.hooks;
    const onAbort = (): void => {
      call.close(call.live(), hooks.abortEnding());
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    const detach = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const ended = (): CallEnding => (signal?.aborted ? hooks.abortEnding() : "error");

    const reader = result.stream.getReader();
    // An aborted call passes nothing further on: its row is closed with what
    // it streamed, and the run keeps exactly that.
    const stop = (controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>): void => {
      detach();
      controller.close();
      reader.cancel().catch(() => undefined);
    };
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async pull(controller) {
        if (call.stopped) {
          stop(controller);
          return;
        }
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (error) {
          call.close(call.live(), ended());
          detach();
          controller.error(error);
          return;
        }
        if (call.stopped) {
          stop(controller);
          return;
        }
        if (next.done) {
          // A stream that ended without `finish` or an error part.
          call.close(call.live(), ended());
          detach();
          controller.close();
          return;
        }
        call.observe(next.value);
        controller.enqueue(next.value);
        if (call.ending !== null) {
          detach();
        } else if (call.checkpoint()) {
          hooks.onCheckpoint?.(metered.payer);
        }
      },
      async cancel(reason) {
        call.close(call.live(), signal?.aborted ? hooks.abortEnding() : "cancel");
        detach();
        await reader.cancel(reason);
      },
    });
    return { ...result, stream };
  }
}
