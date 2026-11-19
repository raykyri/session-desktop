// Input schema pieces the mutator definitions share. Input schemas are
// strict: a field a schema does not list (`likes`, `u`, `createdAt`, `code`)
// is BAD_REQUEST, never stored.

import { spaces } from "@session/shared";
import { z } from "zod";

import { ULID_RE } from "./ids.js";

/** The shared id schema, narrowed to ULIDs whose time fits 48 bits. */
export const ulidS = spaces.spaceUlidSchema.regex(ULID_RE);

/** Handles no person may have: a signed-out caller's absent handle prints as
 * one of them, so a key or log id built from it never names a person. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(["null", "undefined"]);

/** A handle as used in keys (`member:<space>:<handle>`): no ":". */
export const handleS = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .refine((h) => !RESERVED_HANDLES.has(h), "reserved");

export const isHandle = (u: unknown): u is string => handleS.safeParse(u).success;

export const count = z.number().int().nonnegative();

/** The rev of the record a write acts on, as the client saw it. */
export const baseS = z.strictObject({ rev: count });

/** An ask tree node as a write names it: "r" (the thread's ask) or a
 * follow-up's id. */
export const nodeS = z.union([z.literal("r"), ulidS]);
