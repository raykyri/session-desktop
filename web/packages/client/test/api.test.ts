// The wrappers are the seam ported views call, so what matters is that each
// one reaches the procedure `03-api-and-events.md` §2 names, with the input
// that router's schema accepts. A recording client answers both questions
// without a server.

import test from "ava";

import {
  applyResearchRecapCandidate,
  archiveResearchTree,
  cancelResearchNode,
  createResearchHighlight,
  createResearchTree,
  forkResearchNode,
  getMe,
  getResearchNodeContent,
  getResearchTree,
  gitHubSignInUrl,
  listRecentActivity,
  listResearchTrees,
  removeResearchBranch,
  retryResearchNode,
  setDraft,
  setEventInterest,
  setResearchFolders,
  setResearchTreeBookmarked,
  updateSettings,
  uploadDocuments,
} from "../src/api/api.js";
import { setTrpcClient } from "../src/api/trpc.js";

import { createTrpcStub, type TrpcStub } from "./trpcStub.js";

const EMPTY_FOLDERS = { folders: [], membership: {}, starred: [], collapsed: [] };

let stub: TrpcStub;

test.beforeEach(() => {
  stub = createTrpcStub();
  setTrpcClient(stub.client);
});

test.serial("reads reach the query procedures with their inputs", async (t) => {
  await getMe();
  await getResearchTree("t1");
  await listResearchTrees({ workspaceId: "w1", includeArchived: true });
  await getResearchNodeContent("n1");
  await listRecentActivity({ workspaceId: "w1", bookmarkedOnly: true });

  t.deepEqual(stub.calls, [
    { path: "auth.me", kind: "query", input: undefined },
    { path: "research.getTree", kind: "query", input: { treeId: "t1" } },
    {
      path: "research.listTrees",
      kind: "query",
      input: { workspaceId: "w1", includeArchived: true },
    },
    { path: "research.getNodeContent", kind: "query", input: { nodeId: "n1" } },
    {
      path: "feed.recentActivity",
      kind: "query",
      input: { workspaceId: "w1", bookmarkedOnly: true },
    },
  ]);
});

test.serial("writes reach the mutation procedures with their inputs", async (t) => {
  await createResearchTree({ prompt: "why", model: "gemini-flash", workspaceId: "w1" });
  await forkResearchNode({ parentNodeId: "n1", prompt: "and then?" });
  await retryResearchNode("n1");
  await retryResearchNode("n1", "claude-sonnet");
  await cancelResearchNode("n1");
  await archiveResearchTree("t1");
  await setResearchTreeBookmarked("t1", true);
  await removeResearchBranch("n2");
  await createResearchHighlight("n1", {
    version: 1,
    projection: "answer-v1",
    responseRevision: "r1",
    start: 0,
    end: 4,
    exact: "text",
    prefix: "",
    suffix: "",
  });
  await applyResearchRecapCandidate({
    nodeId: "n1",
    expectedResponseRevision: "r1",
    candidate: {
      id: "rc1",
      text: "a recap",
      responseRevision: "r1",
      generatedAt: 1_700_000_000_000,
      model: "gemini-flash",
      instructions: "short",
    },
  });
  await setResearchFolders("w1", EMPTY_FOLDERS);
  await updateSettings({ researchLaunchInstruction: "be brief" });
  await setDraft("home:w1", "{}");
  await setEventInterest("c1", ["n1", "n2"]);

  t.deepEqual(
    stub.calls.map((call) => call.path),
    [
      "research.createTree",
      "research.forkNode",
      "research.retryNode",
      "research.retryNode",
      "research.cancelNode",
      "research.archiveTree",
      "research.setTreeBookmarked",
      "research.removeBranch",
      "highlights.create",
      "recaps.applyCandidate",
      "folders.set",
      "settings.update",
      "drafts.set",
      "events.setInterest",
    ],
  );
  t.true(stub.calls.every((call) => call.kind === "mutate"));
  t.deepEqual(stub.calls[2]?.input, { nodeId: "n1" }, "an absent model is omitted, not null");
  t.deepEqual(stub.calls[3]?.input, { nodeId: "n1", model: "claude-sonnet" });
  t.deepEqual(stub.calls[6]?.input, { treeId: "t1", value: true });
  t.deepEqual(stub.calls[13]?.input, { connectionId: "c1", nodeIds: ["n1", "n2"] });
});

test.serial("sign-in carries the return path and the invite code", (t) => {
  t.is(gitHubSignInUrl(), "/auth/github");
  t.is(
    gitHubSignInUrl("/r/t1?node=n1", "invite-code"),
    "/auth/github?return_to=%2Fr%2Ft1%3Fnode%3Dn1&invite=invite-code",
  );
});

test.serial("an upload posts multipart with the CSRF header", async (t) => {
  const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  class FakeXhr {
    status = 201;
    responseText = "[]";
    withCredentials = false;
    responseType = "";
    readonly upload = { addEventListener: () => undefined };
    readonly #headers: Record<string, string> = {};
    readonly #listeners = new Map<string, () => void>();
    #url = "";
    open(_method: string, url: string) {
      this.#url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.#headers[name] = value;
    }
    addEventListener(name: string, listener: () => void) {
      this.#listeners.set(name, listener);
    }
    send(body: unknown) {
      sent.push({ url: this.#url, headers: this.#headers, body });
      this.#listeners.get("load")?.();
    }
  }
  const original = globalThis.XMLHttpRequest;
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;

  const documents = await uploadDocuments("w1", [new File(["hello"], "a.txt")]);

  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = original;
  t.deepEqual(documents, []);
  t.is(sent[0]?.url, "/uploads");
  t.is(sent[0]?.headers["X-Requested-With"], "session");
  t.true(sent[0]?.body instanceof FormData);
  t.is((sent[0]?.body as FormData).get("workspaceId"), "w1");
});

test.serial("an upload rejects with the server's own message", async (t) => {
  class FailingXhr {
    status = 413;
    responseText = JSON.stringify({ error: "a.txt is larger than 20 MiB" });
    withCredentials = false;
    responseType = "";
    readonly upload = { addEventListener: () => undefined };
    readonly #listeners = new Map<string, () => void>();
    open() {}
    setRequestHeader() {}
    addEventListener(name: string, listener: () => void) {
      this.#listeners.set(name, listener);
    }
    send() {
      this.#listeners.get("load")?.();
    }
  }
  const original = globalThis.XMLHttpRequest;
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FailingXhr;

  const error = await t.throwsAsync(uploadDocuments("w1", [new File([""], "a.txt")]));

  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = original;
  t.is(error?.message, "a.txt is larger than 20 MiB");
});
