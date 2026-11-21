// The model listing and the site's default model and default effort
// (`03-agents-and-research.md` K11, K15; decision P11; ADR-23).

import { siteSettings } from "@session/db";
import type { ModelEntry, SiteEffort } from "@session/shared";
import { DEFAULT_MODEL_ID, MODEL_REGISTRY, findModel } from "@session/shared";
import test from "ava";

import { createHarness } from "./helpers.js";

/** The registry plus a model that runs only on a member's OpenAI key: the
 * registry has none yet, and K15's rule must hold when it does. */
const KEY_ONLY: ModelEntry = {
  ...(findModel("gpt-luna") as ModelEntry),
  id: "openai-key-only",
  label: "OpenAI Key Only",
  payers: ["key:openai"],
};
const WITH_KEY_ONLY: readonly ModelEntry[] = [...MODEL_REGISTRY, KEY_ONLY];

test("models.list returns every registry entry with its payers and efforts, and the defaults", async (t) => {
  const harness = createHarness(t);
  const listing = await harness.caller(harness.addUser("member")).models.list();
  t.deepEqual(
    listing.models.map((m) => m.id),
    MODEL_REGISTRY.map((m) => m.id),
  );
  for (const entry of MODEL_REGISTRY) {
    t.deepEqual(
      listing.models.find((m) => m.id === entry.id),
      {
        id: entry.id,
        label: entry.label,
        provider: entry.provider,
        payers: [...entry.payers],
        efforts: [...entry.efforts],
      },
    );
  }
  t.deepEqual(findModel("claude-fable")?.payers, ["included", "key:anthropic"]);
  // Unset: the registry's default and its own default effort (the launch seed).
  t.is(listing.defaultModel, DEFAULT_MODEL_ID);
  t.is(listing.defaultEffort, findModel(DEFAULT_MODEL_ID)?.defaultEffort as SiteEffort);
  // No prices or descriptions reach the client.
  t.false(JSON.stringify(listing).includes("pricing"));
  await t.throwsAsync(harness.caller(null).models.list(), { code: "UNAUTHORIZED" });
});

test("a member who is not a site admin is refused every admin.models call", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("plain"));
  await t.throwsAsync(caller.admin.models.list(), { code: "FORBIDDEN" });
  await t.throwsAsync(caller.admin.models.setDefault({ model: "claude-fable" }), {
    code: "FORBIDDEN",
  });
  await t.throwsAsync(caller.admin.models.setDefaultEffort({ effort: "high" }), {
    code: "FORBIDDEN",
  });
  t.is(siteSettings.get(harness.db, "default_model"), undefined, "nothing was written");
  t.is(siteSettings.get(harness.db, "default_effort"), undefined);
});

test("a site admin sets the default model and effort; members read them", async (t) => {
  const harness = createHarness(t);
  const admin = harness.caller(harness.addUser("sol", { isAdmin: true }));
  const member = harness.caller(harness.addUser("ines"));

  t.deepEqual(await admin.admin.models.setDefaultEffort({ effort: "max" }), {
    defaultEffort: "max",
  });
  t.deepEqual(await admin.admin.models.setDefault({ model: "claude-fable" }), {
    defaultModel: "claude-fable",
  });
  t.like(await member.models.list(), { defaultModel: "claude-fable", defaultEffort: "max" });
  t.like(await admin.admin.models.list(), { defaultModel: "claude-fable", defaultEffort: "max" });

  // `setDefault` leaves the default effort as it is, even when the new model
  // does not accept it: a composer steps it down (K12).
  await admin.admin.models.setDefault({ model: "gemini-flash" });
  t.like(await member.models.list(), { defaultModel: "gemini-flash", defaultEffort: "max" });
  t.false(findModel("gemini-flash")?.efforts.includes("max"));
});

test("a key-only model cannot be the default", async (t) => {
  const harness = createHarness(t, { deps: { models: WITH_KEY_ONLY } });
  const admin = harness.caller(harness.addUser("sol", { isAdmin: true }));
  await admin.admin.models.setDefault({ model: "deepseek-flash" });
  const error = await t.throwsAsync(admin.admin.models.setDefault({ model: "openai-key-only" }));
  t.like(error, { code: "BAD_REQUEST" });
  t.like(await admin.models.list(), { defaultModel: "deepseek-flash" });
  t.true((await admin.models.list()).models.some((m) => m.id === "openai-key-only"));
  // An id outside the registry is refused as well.
  await t.throwsAsync(admin.admin.models.setDefault({ model: "not-a-model" }), {
    code: "BAD_REQUEST",
  });
});

test("xhigh, or any value outside low, medium, high and max, is refused as the default effort", async (t) => {
  const harness = createHarness(t);
  const admin = harness.caller(harness.addUser("sol", { isAdmin: true }));
  await admin.admin.models.setDefaultEffort({ effort: "low" });
  for (const effort of ["xhigh", "minimal", "default", "", "High", "medium "]) {
    await t.throwsAsync(admin.admin.models.setDefaultEffort({ effort }), {
      code: "BAD_REQUEST",
    });
  }
  t.is((await admin.models.list()).defaultEffort, "low");
  for (const effort of ["low", "medium", "high", "max"]) {
    t.deepEqual(await admin.admin.models.setDefaultEffort({ effort }), { defaultEffort: effort });
  }
});

test("a stored default the registry no longer has reads as the registry's default", async (t) => {
  const harness = createHarness(t);
  const member = harness.caller(harness.addUser("member"));
  siteSettings.set(harness.db, "default_model", "withdrawn-model", null);
  siteSettings.set(harness.db, "default_effort", "extreme", null);
  t.like(await member.models.list(), {
    defaultModel: DEFAULT_MODEL_ID,
    defaultEffort: findModel(DEFAULT_MODEL_ID)?.defaultEffort,
  });
  // Read once, the invalid values are cleared.
  t.is(siteSettings.get(harness.db, "default_model"), undefined);
  t.is(siteSettings.get(harness.db, "default_effort"), undefined);
});

test("an unset effort reads as the default model's own default effort", async (t) => {
  const registry = MODEL_REGISTRY.map((entry) =>
    entry.id === "deepseek-flash" ? { ...entry, defaultEffort: "low" as const } : entry,
  );
  const harness = createHarness(t, { deps: { models: registry } });
  const admin = harness.caller(harness.addUser("sol", { isAdmin: true }));
  await admin.admin.models.setDefault({ model: "deepseek-flash" });
  t.like(await admin.models.list(), { defaultModel: "deepseek-flash", defaultEffort: "low" });
});

test("every change is logged with the admin's id", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("sol", { isAdmin: true });
  const admin = harness.caller(user);
  await admin.admin.models.setDefault({ model: "gpt-luna" });
  await admin.admin.models.setDefaultEffort({ effort: "high" });
  const lines = harness.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (line) => line["message"] === "default model set" || line["message"] === "default effort set",
    );
  t.deepEqual(
    lines.map((line) => [line["message"], line["adminId"], line["model"] ?? line["effort"]]),
    [
      ["default model set", user.id, "gpt-luna"],
      ["default effort set", user.id, "high"],
    ],
  );
});

test("a stored default that became key-only reads as the registry's default", async (t) => {
  const harness = createHarness(t, { deps: { models: WITH_KEY_ONLY } });
  siteSettings.set(harness.db, "default_model", "openai-key-only", null);
  t.is(
    (await harness.caller(harness.addUser("member")).models.list()).defaultModel,
    DEFAULT_MODEL_ID,
  );
});
