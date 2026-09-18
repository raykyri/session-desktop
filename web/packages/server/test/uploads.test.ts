// Document upload, extraction, and the artifact route
// (`04-agent-runtime.md` §8, `11-artifacts-and-browser.md` §2).

import { readFileSync } from "node:fs";

import { documents } from "@session/db";
import type { DocumentInfo } from "@session/shared";
import test from "ava";

import { contentDisposition, parseRange, servedContentType } from "../src/artifacts/route.js";
import { MAX_DOCUMENT_BYTES, resolveMimeType } from "../src/uploads/limits.js";
import { MAX_UPLOAD_BODY_BYTES, documentStoragePath } from "../src/uploads/route.js";

import { ARTIFACT_ORIGIN, PUBLIC_ORIGIN, createHarness } from "./helpers.js";

function upload(
  harness: ReturnType<typeof createHarness>,
  cookie: string,
  workspaceId: string,
  files: { name: string; type: string; body: string | Blob }[],
): Promise<Response> {
  const form = new FormData();
  form.set("workspaceId", workspaceId);
  for (const file of files) {
    form.append("files", new File([file.body], file.name, { type: file.type }));
  }
  return harness.request("/uploads", { method: "POST", body: form, cookie });
}

test("a text upload is stored once, extracted, and listed", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("uploader");
  const cookie = harness.signIn(user);
  const workspace = await harness.caller(user).workspaces.ensureDefault();

  const response = await upload(harness, cookie, workspace.id, [
    { name: "notes.md", type: "text/markdown", body: "# Notes\n\nSome text." },
  ]);
  t.is(response.status, 201);
  const [document] = (await response.json()) as DocumentInfo[];
  t.is(document?.name, "notes.md");
  t.is(document?.mime, "text/markdown");
  t.is(document?.extractionStatus, "ok");

  const storagePath = documentStoragePath(
    harness.config.documentsDir,
    user.id,
    document?.sha256 ?? "",
  );
  t.is(readFileSync(storagePath, "utf8"), "# Notes\n\nSome text.");
  t.deepEqual(documents.readText(harness.db, user.id, document?.id ?? ""), [
    "# Notes\n\nSome text.",
  ]);

  // The same bytes uploaded again are deduplicated by digest.
  const again = await upload(harness, cookie, workspace.id, [
    { name: "copy.md", type: "text/markdown", body: "# Notes\n\nSome text." },
  ]);
  const [duplicate] = (await again.json()) as DocumentInfo[];
  t.is(duplicate?.id, document?.id);
  t.is((await harness.caller(user).documents.list({ workspaceId: workspace.id })).length, 1);
});

test("an unsupported type and an oversized file are refused", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("uploader");
  const cookie = harness.signIn(user);
  const workspace = await harness.caller(user).workspaces.ensureDefault();

  const rejected = await upload(harness, cookie, workspace.id, [
    { name: "runme.exe", type: "application/octet-stream", body: "MZ" },
  ]);
  t.is(rejected.status, 415);

  const tooMany = await upload(
    harness,
    cookie,
    workspace.id,
    Array.from({ length: 11 }, (_unused, index) => ({
      name: `f${index}.txt`,
      type: "text/plain",
      body: "x",
    })),
  );
  t.is(tooMany.status, 400);

  const tooBig = await upload(harness, cookie, workspace.id, [
    { name: "big.txt", type: "text/plain", body: new Blob(["x".repeat(MAX_DOCUMENT_BYTES + 1)]) },
  ]);
  t.is(tooBig.status, 413);
});

test("an upload needs a session", async (t) => {
  const harness = createHarness(t);
  const form = new FormData();
  form.set("workspaceId", "w");
  const response = await harness.request("/uploads", { method: "POST", body: form });
  t.is(response.status, 401);
});

test("a corrupt PDF records a failed extraction without failing the upload", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("uploader");
  const cookie = harness.signIn(user);
  const workspace = await harness.caller(user).workspaces.ensureDefault();
  const response = await upload(harness, cookie, workspace.id, [
    { name: "broken.pdf", type: "application/pdf", body: "%PDF-1.4 not really a pdf" },
  ]);
  t.is(response.status, 201);
  const [document] = (await response.json()) as DocumentInfo[];
  t.is(document?.extractionStatus, "failed");
});

test("the MIME type falls back to the file extension", (t) => {
  t.is(resolveMimeType("text/markdown; charset=utf-8", "a.md"), "text/markdown");
  t.is(resolveMimeType("application/octet-stream", "a.md"), "text/markdown");
  t.is(resolveMimeType("application/octet-stream", "a.bin"), null);
});

test("an artifact token serves the document on the artifact origin only", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("uploader");
  const cookie = harness.signIn(user);
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const uploaded = await upload(harness, cookie, workspace.id, [
    { name: "notes.txt", type: "text/plain", body: "0123456789" },
  ]);
  const [document] = (await uploaded.json()) as DocumentInfo[];
  const minted = await caller.artifacts.mintToken({ documentId: document?.id ?? "" });
  t.true(minted.url.startsWith(`${ARTIFACT_ORIGIN}/a/`));
  const path = new URL(minted.url).pathname;

  // On the app origin the token means nothing.
  t.is((await harness.request(path)).status, 404);

  const artifactHost = new URL(ARTIFACT_ORIGIN).host;
  // `?raw=1` is the byte path: without it a text document is rendered into the
  // styled page (`artifacts.test.ts`).
  const served = await harness.app.request(`${path}?raw=1`, { headers: { Host: artifactHost } });
  t.is(served.status, 200);
  t.is(served.headers.get("content-type"), "text/plain; charset=utf-8");
  t.is(served.headers.get("x-content-type-options"), "nosniff");
  t.is(served.headers.get("referrer-policy"), "no-referrer");
  t.is(served.headers.get("cache-control"), "private, no-store");
  t.is(
    served.headers.get("content-security-policy"),
    `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors ${PUBLIC_ORIGIN}`,
  );
  // The preview panel frames this response, so the app's blanket `DENY` must
  // not reach it; `frame-ancestors` above is what limits the framing.
  t.is(served.headers.get("x-frame-options"), null);
  t.is(await served.text(), "0123456789");

  const ranged = await harness.app.request(`${path}?raw=1`, {
    headers: { Host: artifactHost, Range: "bytes=2-4" },
  });
  t.is(ranged.status, 206);
  t.is(ranged.headers.get("content-range"), "bytes 2-4/10");
  t.is(await ranged.text(), "234");

  const unknown = await harness.app.request("/a/not-a-token", { headers: { Host: artifactHost } });
  t.is(unknown.status, 410);
});

test("HTML is served as text and ranges are parsed conservatively", (t) => {
  t.is(servedContentType("text/html"), "text/plain; charset=utf-8");
  t.is(servedContentType("application/pdf"), "application/pdf");
  t.deepEqual(parseRange("bytes=0-3", 10), { start: 0, end: 3 });
  t.deepEqual(parseRange("bytes=5-", 10), { start: 5, end: 9 });
  t.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  t.is(parseRange("bytes=20-30", 10), null);
  t.is(parseRange("bytes=0-1,4-5", 10), null);
  t.is(parseRange(undefined, 10), null);
  // An empty file has no satisfiable suffix range; `{ start: 0, end: -1 }`
  // would reach `createReadStream` as an out-of-range read.
  t.is(parseRange("bytes=-3", 0), null);
  t.is(parseRange("bytes=-0", 10), null);
  t.is(parseRange("bytes=5-3", 10), null);
});

test("a name outside Latin-1 stays out of the header bytes", (t) => {
  t.is(
    contentDisposition(true, "日本語.txt"),
    `inline; filename="___.txt"; filename*=UTF-8''${encodeURIComponent("日本語.txt")}`,
  );
  t.is(
    contentDisposition(false, 'a"b\\c\r\n.pdf'),
    `attachment; filename="abc.pdf"; filename*=UTF-8''${encodeURIComponent('a"b\\c.pdf')}`,
  );
});

test("a document named outside Latin-1 is still served", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("uploader");
  const cookie = harness.signIn(user);
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const uploaded = await upload(harness, cookie, workspace.id, [
    { name: "日本語.txt", type: "text/plain", body: "hello" },
  ]);
  const [document] = (await uploaded.json()) as DocumentInfo[];
  const minted = await caller.artifacts.mintToken({ documentId: document?.id ?? "" });
  const served = await harness.app.request(`${new URL(minted.url).pathname}?raw=1`, {
    headers: { Host: new URL(ARTIFACT_ORIGIN).host },
  });
  t.is(served.status, 200);
  t.is(await served.text(), "hello");
  t.true(served.headers.get("content-disposition")?.includes("filename*=UTF-8''"));
});

test("a body with no declared length is still bounded", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("uploader");
  const cookie = harness.signIn(user);
  const workspace = await harness.caller(user).workspaces.ensureDefault();
  const boundary = "boundary";
  const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
  let produced = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced === 0) {
        controller.enqueue(
          new TextEncoder().encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="workspaceId"\r\n\r\n${workspace.id}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="big.txt"\r\n` +
              `Content-Type: text/plain\r\n\r\n`,
          ),
        );
      }
      produced += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const response = await harness.app.request("/uploads", {
    method: "POST",
    body,
    duplex: "half",
    headers: {
      Origin: PUBLIC_ORIGIN,
      "X-Requested-With": "session",
      Cookie: `session=${cookie}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
  });
  t.is(response.status, 413);
  // The stream is cut at the ceiling rather than read to its (endless) end.
  t.true(produced <= MAX_UPLOAD_BODY_BYTES + chunk.byteLength);
});
