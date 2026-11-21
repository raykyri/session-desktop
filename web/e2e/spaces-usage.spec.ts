// Usage and API keys end to end (02 W8.1, §12.2; 03 K4, K5, K7): the week's
// usage line, the keys with the check during the request ("Checking…", then
// "Valid"; a rejected key and an unreachable provider refused with nothing
// saved), the format errors, Remove with its confirmation, and the billing
// setting the Anthropic key enables. The server runs with fixture providers,
// which answer the key check by the key's text (`runs/fixtureProvider.ts`):
// no request leaves the machine. The allowance crossing, the overdraft stop
// and the out-of-tokens refusal (K8, K9) are `spaces-billing.spec.ts`.

import { expect, test, type Page } from "@playwright/test";

import { query, signIn } from "./helpers.js";
import { toast } from "./spaces.js";

const ACCEPTED = "sk-ant-e2e-accepted-key-0000000000a1f9";
const HELD = "sk-ant-e2e-held-key-00000000000000b2c3";
const REJECTED = "sk-ant-e2e-rejected-key-000000000000d4";
const UNREACHABLE = "sk-e2e-unreachable-openai-key-0000e5f6";
const OPENAI = "sk-proj-e2e-accepted-openai-key-0077c2";

function keyRow(page: Page, provider: "anthropic" | "openai") {
  return page.locator(`[data-key="${provider}"]`);
}

async function openUsage(page: Page, login: string) {
  await signIn(page, { login });
  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "Usage and API keys", level: 2 })).toBeVisible();
  await expect(page.getByRole("region", { name: "API keys" })).toBeVisible();
}

async function addKey(page: Page, provider: "anthropic" | "openai", raw: string) {
  const row = keyRow(page, provider);
  const add = row.getByRole("button", { name: "Add key" });
  const name = provider === "anthropic" ? "Anthropic API key" : "OpenAI API key";
  const field = row.getByLabel(name);
  // The row shows either Add key or, after a refusal, the open form.
  await expect(add.or(field)).toBeVisible();
  if (await add.isVisible()) await add.click();
  await field.fill(raw);
  await row.getByRole("button", { name: "Save" }).click();
}

/** Holds every `apiKeys.set` request until the returned release is called,
 * so the test sees the row while the check runs. */
async function holdKeyChecks(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/trpc/apiKeys.set**", async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

test("the week's usage and no runs yet", async ({ page }) => {
  await openUsage(page, "e2e-usage-read");
  await expect(page.locator(".usent")).toHaveText(
    /^You have 100% of usage left this week\. Next reset on Fri, in (\d+d )?\d+h\.$/,
  );
  await expect(page.getByRole("img", { name: "100% left" })).toBeVisible();
  await expect(page.getByText("No runs yet this week.")).toBeVisible();
  await expect(keyRow(page, "anthropic")).toContainText("Not set");
  await expect(keyRow(page, "openai")).toContainText("Not set");
});

test("a key is checked during the request: Checking…, then Valid and the toast", async ({
  page,
}) => {
  await openUsage(page, "e2e-usage-keys");
  const row = keyRow(page, "anthropic");
  await expect(page.getByRole("radio", { name: /Continue on my Anthropic key/ })).toBeDisabled();
  await expect(page.getByText("Add a key below to turn this on.")).toBeVisible();

  const release = await holdKeyChecks(page);
  await addKey(page, "anthropic", HELD);
  await expect(row.locator(".chip", { hasText: "Checking…" })).toBeVisible();
  await expect(row.getByText("sk-ant-••••b2c3")).toBeVisible();
  await expect(row.locator(".chip", { hasText: "Valid" })).toHaveCount(0);
  release();
  await expect(toast(page)).toHaveText("Anthropic key works.");
  await expect(row.locator(".chip", { hasText: "Checking…" })).toHaveCount(0);
  await expect(row.locator(".chip", { hasText: "Valid" })).toBeVisible();
  await expect(row.getByText("sk-ant-••••b2c3")).toBeVisible();

  // Stored: the page reads it back after a reload, and the key never
  // reaches the client.
  await page.reload();
  await expect(keyRow(page, "anthropic").locator(".chip", { hasText: "Valid" })).toBeVisible();
  const usage = await query<{ keys: { provider: string; last4: string; status: string }[] }>(
    page.request,
    "usage.get",
    undefined,
  );
  expect(usage.keys).toEqual([
    expect.objectContaining({ provider: "anthropic", last4: "b2c3", status: "valid" }),
  ]);
  expect(JSON.stringify(usage)).not.toContain(HELD);

  // The Anthropic key enables the billing setting.
  const keyRadio = page.getByRole("radio", { name: /Continue on my Anthropic key/ });
  await expect(keyRadio).toBeEnabled();
  await keyRadio.check();
  await expect(toast(page)).toHaveText("Asks will continue on your API key.");
  await page.getByRole("radio", { name: /Pause my asks until the reset/ }).check();
  await expect(toast(page)).toHaveText("Asks will pause until the reset.");

  // Remove asks first; Keep keeps it.
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toContainText("Remove the Anthropic key? Asks billed to it will stop.");
  await row.getByRole("button", { name: "Keep" }).click();
  await expect(row.locator(".chip", { hasText: "Valid" })).toBeVisible();
  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(toast(page)).toHaveText("Anthropic key removed.");
  await expect(row).toContainText("Not set");
  await expect(keyRadio).toBeDisabled();
});

test("a rejected key and an unreachable provider are refused and nothing is saved", async ({
  page,
}) => {
  await openUsage(page, "e2e-usage-refused");
  const anthropic = keyRow(page, "anthropic");
  await addKey(page, "anthropic", REJECTED);
  await expect(anthropic.getByRole("alert")).toHaveText("That key was rejected by Anthropic.");
  await expect(anthropic.getByLabel("Anthropic API key")).toHaveValue(REJECTED);

  const openai = keyRow(page, "openai");
  await addKey(page, "openai", UNREACHABLE);
  await expect(openai.getByRole("alert")).toHaveText(
    "Couldn't reach OpenAI to check the key. Try again.",
  );
  await expect(openai.getByLabel("OpenAI API key")).toHaveValue(UNREACHABLE);

  const usage = await query<{ keys: unknown[] }>(page.request, "usage.get", undefined);
  expect(usage.keys).toEqual([]);

  // A key that works afterwards saves.
  await addKey(page, "anthropic", ACCEPTED);
  await expect(toast(page)).toHaveText("Anthropic key works.");
  await expect(anthropic.locator(".chip", { hasText: "Valid" })).toBeVisible();
});

test("format errors are shown before anything is sent", async ({ page }) => {
  await openUsage(page, "e2e-usage-format");
  const openai = keyRow(page, "openai");
  await addKey(page, "openai", "");
  await expect(openai.getByRole("alert")).toHaveText("Paste a key.");
  await addKey(page, "openai", ACCEPTED);
  await expect(openai.getByRole("alert")).toHaveText(
    "That looks like an Anthropic key. Add it under Anthropic.",
  );
  await addKey(page, "openai", "sk-short");
  await expect(openai.getByRole("alert")).toHaveText(
    "OpenAI keys start with sk- and are longer than this. Copy the whole key from your OpenAI account.",
  );

  // With only an OpenAI key, the billing setting says why it is off.
  await addKey(page, "openai", OPENAI);
  await expect(toast(page)).toHaveText("OpenAI key works.");
  await expect(openai.getByText("sk-••••77c2")).toBeVisible();
  await expect(page.getByRole("radio", { name: /Continue on my Anthropic key/ })).toBeDisabled();
  await expect(page.getByText(/^Needs an Anthropic key\./)).toBeVisible();
});
