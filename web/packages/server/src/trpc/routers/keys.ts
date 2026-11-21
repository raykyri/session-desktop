// `apiKeys.*`, `usage.get`, `usage.listRuns`, `usage.setBilling`
// (`03-agents-and-research.md` K4, K5, K7; ADR-23). Online-only procedures
// (ADR-19): none of this is replicated.

import { apiKeys as keyRepo, billing as billingRepo } from "@session/db";
import { API_KEY_PROVIDERS } from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { ApiKeyView } from "../../keys/apiKeys.js";
import { listKeys, removeKey, setKey } from "../../keys/apiKeys.js";
import { billLabel } from "../../runs/allowance.js";
import { weekOf, weekResetAt } from "../../runs/ledger.js";
import { protectedProcedure, router } from "../base.js";

const providerSchema = z.enum(API_KEY_PROVIDERS);

export const apiKeysRouter = router({
  list: protectedProcedure.query(({ ctx }): ApiKeyView[] => listKeys(ctx, ctx.user.id)),
  /** Checks the key with the provider during the request (10 s timeout) and
   * saves it `valid`; refused and not saved when the provider rejects it or
   * cannot be reached (`03` K4). */
  set: protectedProcedure
    .input(z.object({ provider: providerSchema, raw: z.string().max(1024) }))
    .mutation(({ ctx, input }): Promise<ApiKeyView> =>
      setKey(
        {
          db: ctx.db,
          box: ctx.box,
          fetch: ctx.fetch,
          logger: ctx.logger,
          now: ctx.now,
          ...(ctx.keyCheckTimeoutMs === undefined ? {} : { timeoutMs: ctx.keyCheckTimeoutMs }),
        },
        ctx.user.id,
        input.provider,
        input.raw,
      ),
    ),
  remove: protectedProcedure
    .input(z.object({ provider: providerSchema }))
    .mutation(({ ctx, input }) => ({ removed: removeKey(ctx, ctx.user.id, input.provider) })),
});

/** `usage.get` (`03` K5, K6). */
export interface UsageReading {
  /** Included tokens per week. */
  allowance: number;
  /** Counted included tokens of the current week, open ledger rows counted. */
  used: number;
  /** When the week resets: the next Friday 00:00 UTC (epoch ms). */
  resetAt: number;
  /** What happens when included tokens run out (`03` K7). Literal unions
   * are written out here, not named: the client compiles against these
   * types and cannot name a module of this package (ADR-1). */
  billing: "pause" | "key";
  keys: ApiKeyView[];
}

/** One row of `usage.listRuns`. */
export interface UsageRun {
  runId: string;
  /** The question as the person may read it now; null with `missing`. */
  question: string | null;
  missing: "removed" | "unavailable" | null;
  /** Counted tokens of the run, every payer. */
  tokens: number;
  /** Counted included tokens over the weekly allowance. */
  share: number;
  /** Who paid (`03` K9). */
  bill: "included" | "key:anthropic" | "key:openai" | "included+key:anthropic";
  /** When the run's first call started (epoch ms). */
  at: number;
}

export interface UsageRunsPage {
  runs: UsageRun[];
  /** Pass as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
}

const cursorOf = (run: { startedAt: number; runId: string }) => `${run.startedAt}:${run.runId}`;

/** Whether `run` comes after the cursor's run in the listing's order
 * (newest `startedAt` first, then run id descending). A cursor whose run is
 * gone still pages from where it was; a malformed one starts over. */
function isAfterCursor(run: { startedAt: number; runId: string }, cursor: string): boolean {
  const split = cursor.indexOf(":");
  const at = Number(cursor.slice(0, split));
  const runId = cursor.slice(split + 1);
  if (split < 0 || !Number.isFinite(at)) return true;
  return run.startedAt < at || (run.startedAt === at && run.runId < runId);
}

function hasValidAnthropicKey(
  ctx: { db: Parameters<typeof keyRepo.find>[0] },
  userId: string,
): boolean {
  return keyRepo.find(ctx.db, userId, "anthropic")?.status === "valid";
}

export const usageProcedures = {
  get: protectedProcedure.query(({ ctx }): UsageReading => {
    const at = ctx.now();
    return {
      allowance: ctx.config.limits.weeklyTokens,
      used: ctx.ledger.includedUsage(ctx.user.id, weekOf(at)),
      resetAt: weekResetAt(at),
      billing: billingRepo.get(ctx.db, ctx.user.id),
      keys: listKeys(ctx, ctx.user.id),
    };
  }),
  /** The person's runs of the current week, newest first, paged. A run whose
   * thread or node was removed, or whose thread the person can no longer
   * read, is listed without its question (`03` K5). */
  listRuns: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).optional(),
          cursor: z.string().max(200).nullish(),
        })
        .optional(),
    )
    .query(({ ctx, input }): UsageRunsPage => {
      const limit = input?.limit ?? 6;
      const allowance = ctx.config.limits.weeklyTokens;
      const all = ctx.ledger.runsOf(ctx.user.id, weekOf(ctx.now()));
      const after = input?.cursor ?? null;
      const found = after === null ? 0 : all.findIndex((run) => isAfterCursor(run, after));
      const start = found < 0 ? all.length : found;
      const page = all.slice(start, start + limit);
      const last = page.at(-1);
      return {
        runs: page.map((run) => {
          const text = ctx.runTexts.questionOf(ctx.user.id, run.runId);
          return {
            runId: run.runId,
            question: "question" in text ? text.question : null,
            missing: "missing" in text ? text.missing : null,
            tokens: run.counted,
            share: allowance > 0 ? run.includedCounted / allowance : 0,
            bill: billLabel(run.payers) ?? "included",
            at: run.startedAt,
          };
        }),
        nextCursor: last && start + limit < all.length ? cursorOf(last) : null,
      };
    }),
  /** What happens when included tokens run out (`03` K7): `key` needs a
   * valid Anthropic key, else `PRECONDITION_FAILED`. */
  setBilling: protectedProcedure
    .input(z.object({ mode: z.enum(["pause", "key"]) }))
    .mutation(({ ctx, input }): { billing: "pause" | "key" } => {
      if (input.mode === "key" && !hasValidAnthropicKey(ctx, ctx.user.id)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Add a working Anthropic key to continue on it.",
        });
      }
      return { billing: billingRepo.set(ctx.db, ctx.user.id, input.mode) };
    }),
};
