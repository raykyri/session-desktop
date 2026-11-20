// Phase 2a design finding 6, accepted in phase 2 review round 1: who pays is
// aware of providers. A key pays only for its own provider's models (the
// server's rule), so the composer lists the models the payer runs and
// changes a model the payer cannot run, with the mockup's note.

import type { ModelInfo } from "@session/shared";
import test from "ava";

import { modelChoice, modelsFor } from "../src/spaces/Composer.js";

const model = (
  id: string,
  provider: ModelInfo["provider"],
  o: Partial<ModelInfo> = {},
): ModelInfo => ({
  id,
  label: id.toUpperCase(),
  provider,
  adminOnly: false,
  available: true,
  supportsFiles: false,
  supportsImages: false,
  ...o,
});

const MODELS = [
  model("gemini", "vertex"),
  model("claude", "anthropic"),
  model("router", "openrouter"),
  model("big", "anthropic", { adminOnly: true }),
  model("off", "openrouter", { available: false }),
];
const KEYS = [
  { id: "K1", name: "Work key", provider: "Anthropic" },
  { id: "K2", name: "Router key", provider: "OpenRouter" },
  { id: "K3", name: "Gemini key", provider: "Google" },
];
const ids = (l: ModelInfo[]) => l.map((m) => m.id);

test("the included tokens run every available model; one only for admins, for an admin", (t) => {
  t.deepEqual(ids(modelsFor("session", MODELS, KEYS, false)), ["gemini", "claude", "router"]);
  t.deepEqual(ids(modelsFor("session", MODELS, KEYS, true)), ["gemini", "claude", "router", "big"]);
});

test("a key runs only its own provider's models", (t) => {
  t.deepEqual(ids(modelsFor("K1", MODELS, KEYS, false)), ["claude", "big"]);
  t.deepEqual(ids(modelsFor("K2", MODELS, KEYS, false)), ["router"]);
  // no model of the server's runs on a Google key
  t.deepEqual(ids(modelsFor("K3", MODELS, KEYS, false)), []);
  t.deepEqual(ids(modelsFor("gone", MODELS, KEYS, false)), []);
});

test("a model the key cannot run changes to one it can, with the mockup's note", (t) => {
  const c = modelChoice("K1", "gemini", MODELS, KEYS, false);
  t.is(c.model?.id, "claude");
  t.is(c.note, "Work key runs Claude models, so the model changed from GEMINI to CLAUDE.");
  const r = modelChoice("K2", "claude", MODELS, KEYS, false);
  t.is(r.model?.id, "router");
  t.is(r.note, "Router key runs OpenRouter models, so the model changed from CLAUDE to ROUTER.");
});

test("a model the payer runs stays, with no note; no choice is the payer's first model", (t) => {
  t.deepEqual(
    { m: modelChoice("K1", "claude", MODELS, KEYS, false).model?.id, n: null },
    { m: "claude", n: null },
  );
  t.is(modelChoice("K1", "claude", MODELS, KEYS, false).note, null);
  t.is(modelChoice("session", "", MODELS, KEYS, false).model?.id, "gemini");
  t.is(modelChoice("session", "", MODELS, KEYS, false).note, null);
  // an admin-only model on the included tokens, for someone who is not an admin
  t.is(modelChoice("session", "big", MODELS, KEYS, false).model?.id, "gemini");
});
