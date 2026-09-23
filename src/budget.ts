import type { Config } from "./config.js";
import { LimitError } from "./errors.js";
import type { Usage } from "./http.js";
import type { CodingModel, Message, ToolSpec } from "./llm.js";
import { requireImageSupport } from "./media.js";

export interface Reservation { settle(usage: Usage): void; fail(): void }
interface Ledger { cost: number; unknown: boolean; incomplete: number; turns: number }
type Rate = NonNullable<Config["spend"]["jev"]>;

/** Synchronous reservations prevent parallel requests from spending the same remaining allowance. */
export class RunBudget {
  private config: Config;
  #tokens: number;
  #turns: number;
  #usd: number | undefined;
  #released = false;
  #pending = 0;

  constructor(config: Config, private ledger: Ledger = { cost: 0, unknown: false, incomplete: 0, turns: 0 },
    private parent?: RunBudget, allocation?: { tokens: number; turns: number; usd?: number }) {
    this.config = structuredClone(config);
    this.#tokens = allocation?.tokens ?? config.limits.maxTokens;
    this.#turns = allocation?.turns ?? config.limits.maxTurns;
    this.#usd = allocation?.usd ?? config.spend.maxUsd;
  }

  get costUsd(): number | null { return this.ledger.unknown || this.ledger.incomplete ? null : this.ledger.cost; }
  get reportedCostUsd(): number { return this.ledger.cost; }
  get turns(): number { return this.ledger.turns; }

  assertCompatible(config: Config): void {
    const policy = (value: Config): string => JSON.stringify({
      limits: value.limits, spend: value.spend, provider: value.llm.provider,
    });
    if (policy(config) !== policy(this.config)) throw new LimitError("Injected budget does not match the current run policy");
  }

  reserveImageRequest(model: string, textInputUpper: number, outputUpper: number): Reservation {
    if (this.#usd !== undefined) {
      throw new LimitError("Image input token bounds are unknown for this provider/model; a reported-dollar cap cannot safely admit this request");
    }
    const inputAllowance = this.#tokens - outputUpper;
    if (inputAllowance < textInputUpper) throw new LimitError("Shared token budget cannot reserve this image request and its text context");
    return this.reserve("llm", model, inputAllowance, outputUpper);
  }

  allocate(turnLimits: number[]): RunBudget[] {
    if (this.#released) throw new LimitError("Budget scope is closed");
    if (!turnLimits.length || turnLimits.some((limit) => !Number.isSafeInteger(limit) || limit < 1)) {
      throw new LimitError("Specialist reservations require positive integer turn limits");
    }
    const count = turnLimits.length;
    const tokens = Math.floor(this.#tokens / (count + 1));
    const turns = Math.floor(this.#turns / (count + 1));
    const usd = this.#usd === undefined ? undefined : this.#usd / (count + 1);
    if (!tokens || !turns) throw new LimitError("Insufficient shared budget to reserve specialist work and a parent turn");
    return turnLimits.map((maxTurns) => {
      const allocatedTurns = Math.min(turns, maxTurns);
      this.#tokens -= tokens;
      this.#turns -= allocatedTurns;
      if (usd !== undefined) this.#usd! -= usd;
      return new RunBudget(this.config, this.ledger, this, { tokens, turns: allocatedTurns, ...(usd === undefined ? {} : { usd }) });
    });
  }

  reserve(source: "llm" | "jev", model: string, inputUpper: number, outputUpper: number): Reservation {
    if (this.#released) throw new LimitError("Budget scope is closed");
    if (![inputUpper, outputUpper].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new LimitError("Request reservations require nonnegative integer token bounds");
    }
    const configuredRate: Rate | undefined = source === "jev" ? this.config.spend.jev :
      this.config.spend.models[`${this.config.llm.provider}/${model}`];
    const rate = configuredRate ? { ...configuredRate } : undefined;
    if (this.#usd !== undefined && !rate) {
      throw new LimitError(`Spend cap requires explicit ${source === "jev" ? "Jev" : `${this.config.llm.provider}/${model}`} rates; price is unknown`);
    }
    const cost = (usage: Usage): number => rate ?
      (usage.inputTokens * rate.inputUsdPerMillion + usage.outputTokens * rate.outputUsdPerMillion) / 1_000_000 : 0;
    const tokens = inputUpper + outputUpper;
    const usd = cost({ inputTokens: inputUpper, outputTokens: outputUpper });
    if (!Number.isFinite(usd)) throw new LimitError("Configured rates exceed the supported dollar range");
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > this.#tokens) throw new LimitError("Shared token budget cannot reserve this request");
    if (source === "llm" && this.#turns < 1) throw new LimitError("Shared turn budget reached");
    if (this.#usd !== undefined && usd > this.#usd) throw new LimitError("Reported-dollar spend cap cannot reserve this request");
    this.#tokens -= tokens;
    if (this.#usd !== undefined) this.#usd -= usd;
    if (source === "llm") { this.#turns--; this.ledger.turns++; }
    this.#pending++;
    this.ledger.incomplete++;
    let settled = false;
    return {
      settle: (usage) => {
        if (settled) throw new Error("Usage reservation already settled");
        settled = true;
        this.#pending--;
        this.ledger.incomplete--;
        if (![usage.inputTokens, usage.outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) {
          this.ledger.unknown = true;
          throw new LimitError("Invalid usage report; request allowance retained");
        }
        this.#tokens += tokens - usage.inputTokens - usage.outputTokens;
        const actual = cost(usage);
        if (this.#usd !== undefined) this.#usd += usd - actual;
        if (!rate) this.ledger.unknown = true;
        else this.ledger.cost += actual;
        if (usage.inputTokens > inputUpper || usage.outputTokens > outputUpper || this.#tokens < 0 || (this.#usd !== undefined && this.#usd < -1e-12)) {
          throw new LimitError("Provider usage exceeded the conservative request reservation; stopped. Reported totals may overshoot by this request");
        }
      },
      fail: () => {
        if (settled) return;
        settled = true;
        this.#pending--;
        // Unreported usage retains its entire reservation; do not fund retries from unknown usage.
      },
    };
  }

  release(): void {
    if (!this.parent || this.#released) return;
    if (this.#pending) throw new Error("Cannot release a budget with requests in flight");
    this.#released = true;
    this.parent.#tokens += this.#tokens;
    this.parent.#turns += this.#turns;
    if (this.parent.#usd !== undefined && this.#usd !== undefined) this.parent.#usd += this.#usd;
  }
}

export function reserveModelRequest(budget: RunBudget, model: CodingModel, modelId: string,
  messages: Message[], tools: ToolSpec[], maxOutputTokens: number): Reservation {
  let hasImages = false;
  const textMessages = messages.map((message): Message => {
    if (!message.images?.length) return message;
    requireImageSupport(model, modelId, message.images);
    hasImages = true;
    const { images: _images, ...text } = message;
    return text;
  });
  const textInputUpper = Math.max(Buffer.byteLength(JSON.stringify({ messages: textMessages, tools })),
    model.contextSize ? 3 * model.contextSize(textMessages, tools) : 0) + 4096;
  return hasImages ? budget.reserveImageRequest(modelId, textInputUpper, maxOutputTokens) :
    budget.reserve("llm", modelId, textInputUpper, maxOutputTokens);
}
