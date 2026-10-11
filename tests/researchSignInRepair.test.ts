import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAdapterMetadata, ResearchNode } from "../src/types";
import { buildSegmentView } from "../src/lib/researchSegmentView";
import { researchNode, withRun } from "./researchNodeFixture";

// The repair panel reaches the adapter icons through Agent Setup.
register("./svgStubLoader.mjs", import.meta.url);
const {
  ResearchAgentRepairContext,
  SignInRepairView,
  repairAgentFor,
  signInRepairOutcome,
} = await import("../src/components/research/ResearchSignInRepair");
const { ResearchAnswerPane } = await import("../src/components/research/ResearchTurn");

function agent(
  id: string,
  over: Partial<AgentAdapterMetadata> = {},
): AgentAdapterMetadata {
  return {
    id,
    label: id === "claude" ? "Claude Code" : id === "codex" ? "Codex" : id,
    default: id === "claude",
    supportsFork: true,
    supportsResearch: true,
    supportsRecapGeneration: true,
    supportsForkAtMessage: true,
    supportsRemote: true,
    configuredBinary: id,
    resolvedBinary: `/bin/${id}`,
    readiness: "ready",
    researchReadiness: "ready",
    message: null,
    version: "1.0.0",
    auth: "authenticated",
    authDetail: null,
    checkedAt: 1_700_000_000_000,
    loginCommand: `'${id}' login`,
    installCommand: null,
    installUrl: null,
    updateCommand: null,
    instanceId: `local:${id}`,
    target: { kind: "local", id: null, label: "This Mac" },
    ...over,
  };
}

const SIGN_IN_ERROR =
  "Codex is not signed in. Run `codex login` in Terminal to sign in, then retry this research.";

test("repair targets the failed run's own agent, not another selection", () => {
  const adapters = [
    agent("claude"),
    agent("codex", { instanceId: "remote:devbox:codex", target: { kind: "remote", id: "devbox", label: "devbox" } }),
    agent("codex"),
  ];
  assert.equal(repairAgentFor(adapters, "codex")?.instanceId, "local:codex");
  assert.equal(repairAgentFor(adapters, "grok"), null);
});

test("only a verified sign-in reports a successful repair", () => {
  const verified = signInRepairOutcome("Codex", agent("codex"), null);
  assert.equal(verified.kind, "verified");
  assert.equal(verified.canRetry, true);
  assert.equal(verified.message, "Codex is signed in. Retry this question with Codex.");

  const stillSignedOut = signInRepairOutcome(
    "Codex",
    agent("codex", { readiness: "needsAuth", researchReadiness: "needsAuth", auth: "unauthenticated" }),
    null,
  );
  assert.equal(stillSignedOut.kind, "signedOut");
  assert.equal(stillSignedOut.canRetry, false);
  assert.match(stillSignedOut.message, /still not signed in/);

  const failedCheck = signInRepairOutcome("Codex", null, "`codex login status` timed out");
  assert.equal(failedCheck.kind, "checkFailed");
  assert.equal(failedCheck.canRetry, false);
  assert.equal(failedCheck.message, "The status check failed: `codex login status` timed out");

  // Inconclusive: retrying is an explicit attempt, and it is not called
  // signed in.
  const unverified = signInRepairOutcome(
    "Codex",
    agent("codex", { auth: "unknown", authDetail: "The sign-in status check failed: timed out." }),
    null,
  );
  assert.equal(unverified.kind, "unverified");
  assert.equal(unverified.canRetry, true);
  assert.doesNotMatch(unverified.message, /is signed in/);

  const unavailable = signInRepairOutcome(
    "Codex",
    agent("codex", { researchReadiness: "error", message: "Remote terminal ready; Research remains local-only." }),
    null,
  );
  assert.equal(unavailable.kind, "blocked");
  assert.equal(unavailable.canRetry, false);
  assert.equal(signInRepairOutcome("Codex", null, null).canRetry, false);
});

function renderView(props: Partial<Parameters<typeof SignInRepairView>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SignInRepairView, {
      label: "Codex",
      loginCommand: "'codex' login",
      checking: false,
      outcome: null,
      retrying: false,
      onCopied: () => {},
      onError: () => {},
      onVerify: () => {},
      onRetry: () => {},
      onClose: () => {},
      ...props,
    }),
  );
}

test("the repair panel names the sign-in command and verification, nothing else", () => {
  const html = renderView();
  assert.match(html, /Sign in to Codex/);
  assert.match(html, /Run this command in Terminal, finish signing in, then verify here\./);
  assert.match(html, /<code>&#x27;codex&#x27; login<\/code>/);
  assert.match(html, /Verify sign-in/);
  assert.doesNotMatch(html, /Retry this research/);
  // No removed terminal surface, and no credential-ownership explanation.
  assert.doesNotMatch(html, /terminal tab/i);
  assert.doesNotMatch(html, /keeps ownership|credentials/i);
});

test("a failed verification leaves the panel open and hides Retry", () => {
  const html = renderView({
    outcome: signInRepairOutcome(
      "Codex",
      agent("codex", { readiness: "needsAuth", researchReadiness: "needsAuth", auth: "unauthenticated" }),
      null,
    ),
  });
  assert.match(html, /is-signedOut"[^>]*>Codex is still not signed in/);
  assert.match(html, /Check again/);
  assert.doesNotMatch(html, /Retry this research/);
});

test("a verified sign-in shows one Retry this research action", () => {
  const verified = signInRepairOutcome("Codex", agent("codex"), null);
  const ready = renderView({ outcome: verified });
  assert.match(ready, /<button class="control-button research-turn-button" type="button">.*Retry this research/);
  // While the retry request is pending the button reports it and ignores
  // further clicks (the thread's retry control also blocks duplicate requests).
  const pending = renderView({ outcome: verified, retrying: true });
  assert.match(pending, /aria-disabled="true"[^>]*>.*Retrying…/);
  assert.doesNotMatch(pending, /Retry this research/);
});

function renderPane(node: ResearchNode, options: { canRetry?: boolean } = {}) {
  const noop = () => {};
  const view = buildSegmentView(node, { node, turns: [] }, false, false);
  return renderToStaticMarkup(
    createElement(
      ResearchAgentRepairContext.Provider,
      {
        value: {
          adapters: [agent("claude"), agent("codex")],
          verify: async () => [],
          onCopied: noop,
          onError: noop,
        },
      },
      createElement(ResearchAnswerPane, {
        view,
        node,
        contentError: null,
        cancelling: false,
        elapsedSince: null,
        waitsForParent: false,
        recapPending: false,
        pointerOverAnnotation: false,
        canRetry: options.canRetry ?? true,
        retrying: false,
        retryQueued: false,
        canEditQuestion: true,
        registerSegmentElement: noop,
        onExpandTurns: noop,
        onRetryContentLoad: noop,
        onToggleFullTrace: noop,
        onCancelNode: noop,
        onRetryNode: noop,
        onRemoveQueuedRetry: noop,
        onEditQuestion: noop,
        onRootMouseDown: noop,
        onRootMouseUp: noop,
        onRootKeyUp: noop,
        onRootClick: noop,
        onRootMouseMove: noop,
        onRootMouseLeave: noop,
      }),
    ),
  );
}

test("a recognized sign-in failure shows Repair sign-in beside Retry", () => {
  const failed = withRun(researchNode({ adapter: "codex", status: "failed", error: SIGN_IN_ERROR }), {
    errorKind: "auth",
  });
  const html = renderPane(failed);
  assert.match(html, /Error\.<\/b> Codex is not signed in\. Run `codex login` in Terminal/);
  assert.match(html, /Repair sign-in/);
  assert.match(html, /<span>Retry<\/span>/);
  assert.match(html, /Edit question/);
  assert.doesNotMatch(html, /terminal tab/i);
  // An archived thread cannot retry, so it offers no repair either.
  assert.doesNotMatch(renderPane(failed, { canRetry: false }), /Repair sign-in/);
});

test("an unclassified failure shows the plain error and Retry", () => {
  const failed = researchNode({
    adapter: "codex",
    status: "failed",
    error: "stream disconnected before completion",
  });
  const html = renderPane(failed);
  assert.match(html, /stream disconnected before completion/);
  assert.match(html, /<span>Retry<\/span>/);
  assert.doesNotMatch(html, /Repair sign-in|Sign in to/);
});

test("the repair panel's details describe the run's agent as last checked", () => {
  const html = renderView({
    agent: agent("codex", {
      readiness: "needsAuth",
      researchReadiness: "needsAuth",
      auth: "unauthenticated",
      message: "Codex is not signed in. Run `codex login` and check again.",
    }),
  });
  assert.match(html, /<summary>Details<\/summary>/);
  assert.match(html, /<dt>Executable<\/dt><dd>\/bin\/codex<\/dd>/);
  assert.match(html, /<dt>Version<\/dt><dd>1\.0\.0<\/dd>/);
});
