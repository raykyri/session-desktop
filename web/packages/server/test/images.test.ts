// Image attachments: the upload route and its limits (5 MB per image,
// downscaling to 2048 px, 20 MB per upload, the type read from the bytes),
// the owner-checked image and thumbnail route, the procedures that accept
// image ids, the image parts a run sends, and the sweep.

import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { images } from "@session/db";
import type { ResearchImageAttachment } from "@session/shared";
import {
  DOWNSCALED_IMAGE_SIDE,
  IMAGE_THUMBNAIL_SIDE,
  MAX_IMAGE_BYTES,
  MAX_INPUT_IMAGE_BYTES,
  researchImageUrl,
} from "@session/shared";
import type { TRPCError } from "@trpc/server";
import test from "ava";
import sharp from "sharp";

import { RunInputError, classifyRunError } from "../src/runs/errors.js";
import { imageParts } from "../src/runs/messages.js";
import { thumbnailPath } from "../src/uploads/images.js";
import { sweepImages } from "../src/uploads/storage.js";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#3366cc" } })
    .png()
    .toBuffer();
}

/** A PNG of random pixels, which does not compress: about 3 bytes a pixel. */
async function noisePng(width: number, height: number): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

function signedIn(harness: Harness, login: string) {
  const user = harness.addUser(login);
  return { user, cookie: harness.signIn(user), caller: harness.caller(user) };
}

async function upload(
  harness: Harness,
  cookie: string,
  bytes: Uint8Array,
  name = "pasted.png",
  type = "image/png",
): Promise<Response> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type }));
  return harness.request("/api/images", { method: "POST", body: form, cookie });
}

async function uploaded(harness: Harness, cookie: string, bytes: Uint8Array, name?: string) {
  const response = await upload(harness, cookie, bytes, name);
  if (response.status !== 201) {
    throw new Error(`upload failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as ResearchImageAttachment;
}

test("an image within the limits is stored as uploaded, with a thumbnail", async (t) => {
  const harness = createHarness(t);
  const { cookie, user } = signedIn(harness, "uploader");
  const bytes = await png(640, 480);
  const attachment = await uploaded(harness, cookie, bytes, "C:\\Users\\me\\shot.png");
  t.is(attachment.kind, "image");
  t.is(attachment.mimeType, "image/png");
  t.is(attachment.byteSize, bytes.byteLength);
  t.is(attachment.width, 640);
  t.is(attachment.height, 480);
  t.is(attachment.fileName, "shot.png", "only the last path component is kept");

  const row = images.get(harness.db, user.id, attachment.id);
  t.is(row?.attachedAt, null, "pending until a message names it");
  t.true(row?.storagePath.startsWith(join(harness.config.documentsDir, user.id)));

  const image = await harness.request(researchImageUrl(attachment.id), { cookie });
  t.is(image.status, 200);
  t.is(image.headers.get("content-type"), "image/png");
  t.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);

  const thumbnail = await harness.request(researchImageUrl(attachment.id, { thumbnail: true }), {
    cookie,
  });
  t.is(thumbnail.status, 200);
  t.is(thumbnail.headers.get("content-type"), "image/jpeg");
  const size = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
  t.is(Math.max(size.width, size.height), IMAGE_THUMBNAIL_SIDE);
});

test("images are served to their owner only", async (t) => {
  const harness = createHarness(t);
  const owner = signedIn(harness, "owner");
  const other = signedIn(harness, "other");
  const attachment = await uploaded(harness, owner.cookie, await png(10, 10));
  const path = researchImageUrl(attachment.id);
  t.is((await harness.request(path, { cookie: other.cookie })).status, 404);
  t.is((await harness.request(path)).status, 401);
  t.is((await harness.request("/images/no-such-image", { cookie: owner.cookie })).status, 404);
  const anonymous = await upload(harness, "", await png(10, 10));
  t.is(anonymous.status, 401);
});

test("a PNG over 5 MB or 8000 px is downscaled to a 2048 px JPEG", async (t) => {
  const harness = createHarness(t);
  const { cookie } = signedIn(harness, "big-uploader");
  const heavy = await noisePng(1400, 1400);
  t.true(heavy.byteLength > MAX_IMAGE_BYTES);
  const fromHeavy = await uploaded(harness, cookie, heavy);
  t.is(fromHeavy.mimeType, "image/jpeg");
  t.true(fromHeavy.byteSize <= MAX_IMAGE_BYTES);
  t.is(fromHeavy.width, 1400, "an image within 2048 px keeps its size");

  const wide = await uploaded(harness, cookie, await png(8001, 10));
  t.is(wide.mimeType, "image/jpeg");
  t.is(wide.width, DOWNSCALED_IMAGE_SIDE);
});

test("uploads are refused by type, size and emptiness, not by the reported type", async (t) => {
  const harness = createHarness(t);
  const { cookie } = signedIn(harness, "refused-uploader");
  const text = await upload(harness, cookie, Buffer.from("not an image"), "a.png", "image/png");
  t.is(text.status, 415);
  t.deepEqual(await text.json(), {
    error: "Only PNG, JPEG, GIF, and WebP images can be attached.",
  });

  const empty = await upload(harness, cookie, new Uint8Array(0));
  t.is(empty.status, 400);

  // A GIF is not re-encoded, so it must already fit.
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(MAX_IMAGE_BYTES)]);
  const bigGif = await upload(harness, cookie, gif, "big.gif", "image/gif");
  t.is(bigGif.status, 413);
  t.deepEqual(await bigGif.json(), { error: "GIF and WebP images must be 5 MB or smaller." });

  const huge = Buffer.concat([await png(10, 10), Buffer.alloc(MAX_INPUT_IMAGE_BYTES)]);
  const tooLarge = await upload(harness, cookie, huge);
  t.is(tooLarge.status, 413);
  t.deepEqual(await tooLarge.json(), { error: "Images must be 20 MB or smaller." });
});

test("a GIF is served whole as its own thumbnail", async (t) => {
  const harness = createHarness(t);
  const { cookie } = signedIn(harness, "gif-uploader");
  const gif = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#fff" } })
    .gif()
    .toBuffer();
  const attachment = await uploaded(harness, cookie, gif, "a.gif");
  t.is(attachment.mimeType, "image/gif");
  const thumbnail = await harness.request(researchImageUrl(attachment.id, { thumbnail: true }), {
    cookie,
  });
  t.is(thumbnail.headers.get("content-type"), "image/gif");
  t.deepEqual(Buffer.from(await thumbnail.arrayBuffer()), gif);
});

test("a missing thumbnail is written again on request", async (t) => {
  const harness = createHarness(t);
  const { cookie, user } = signedIn(harness, "thumb-regenerator");
  const attachment = await uploaded(harness, cookie, await png(400, 300));
  const path = thumbnailPath(images.get(harness.db, user.id, attachment.id)?.storagePath ?? "");
  unlinkSync(path);
  const thumbnail = await harness.request(researchImageUrl(attachment.id, { thumbnail: true }), {
    cookie,
  });
  t.is(thumbnail.headers.get("content-type"), "image/jpeg");
  t.true(existsSync(path));
});

test("createTree attaches uploaded images to the question", async (t) => {
  const harness = createHarness(t);
  const { cookie, caller, user } = signedIn(harness, "attacher");
  const workspace = await caller.workspaces.ensureDefault();
  const first = await uploaded(harness, cookie, await png(10, 10));
  const second = await uploaded(harness, cookie, await png(20, 20));

  const question = await caller.research.createTree({
    prompt: "What is in this picture?",
    model: "gemini-flash",
    workspaceId: workspace.id,
    images: [first.id, second.id, first.id],
  });
  t.deepEqual(question.nodes[0]?.message?.attachments, [first, second]);
  t.not(images.get(harness.db, user.id, first.id)?.attachedAt, null);
});

test("image ids are checked before anything is written", async (t) => {
  const harness = createHarness(t);
  const owner = signedIn(harness, "image-owner");
  const other = signedIn(harness, "image-borrower");
  const workspace = await other.caller.workspaces.ensureDefault();
  const attachment = await uploaded(harness, owner.cookie, await png(10, 10));

  const foreign = await t.throwsAsync<TRPCError>(
    other.caller.research.createTree({
      prompt: "Whose image?",
      model: "gemini-flash",
      workspaceId: workspace.id,
      images: [attachment.id],
    }),
  );
  t.is(foreign?.code, "BAD_REQUEST");
  t.is(foreign?.message, images.IMAGE_UNAVAILABLE);
  t.deepEqual(await other.caller.research.listTrees({ workspaceId: workspace.id }), []);

  const ownWorkspace = await owner.caller.workspaces.ensureDefault();
  const blind = await t.throwsAsync<TRPCError>(
    owner.caller.research.createTree({
      prompt: "Describe this",
      model: "deepseek-flash",
      workspaceId: ownWorkspace.id,
      images: [attachment.id],
    }),
  );
  t.is(blind?.code, "BAD_REQUEST");
  t.regex(blind?.message ?? "", /can't read images\.$/);
});

test("a run sends the node's images as image parts", async (t) => {
  const harness = createHarness(t);
  const { cookie, caller } = signedIn(harness, "runner");
  const workspace = await caller.workspaces.ensureDefault();
  const bytes = await png(30, 30);
  const attachment = await uploaded(harness, cookie, bytes);
  const detail = await caller.research.createTree({
    prompt: "Look",
    model: "gemini-flash",
    workspaceId: workspace.id,
    images: [attachment.id],
  });
  const node = detail.nodes[0];
  if (!node) throw new Error("no root");
  const parts = await imageParts(harness.db, node);
  t.is(parts.length, 1);
  t.is(parts[0]?.mediaType, "image/png");
  t.deepEqual(Buffer.from(parts[0]?.image as Uint8Array), bytes);

  // An image whose file is gone fails the attempt with the desktop's message.
  const stored = images.findById(harness.db, attachment.id);
  unlinkSync(stored?.storagePath ?? "");
  const error = await t.throwsAsync(imageParts(harness.db, node), { instanceOf: RunInputError });
  t.is(classifyRunError(error).message, images.IMAGE_UNAVAILABLE);
});

test("the sweep removes unattached images and their files after a day", async (t) => {
  const harness = createHarness(t);
  const { cookie, caller, user } = signedIn(harness, "sweeper");
  const workspace = await caller.workspaces.ensureDefault();
  const pending = await uploaded(harness, cookie, await png(10, 10));
  const attached = await uploaded(harness, cookie, await png(12, 12));
  await caller.research.createTree({
    prompt: "Keep",
    model: "gemini-flash",
    workspaceId: workspace.id,
    images: [attached.id],
  });
  const pendingPath = images.get(harness.db, user.id, pending.id)?.storagePath ?? "";
  const attachedPath = images.get(harness.db, user.id, attached.id)?.storagePath ?? "";
  const stray = join(harness.config.documentsDir, user.id, "stray");
  writeFileSync(stray, "bytes");

  const later = Date.now() + images.PENDING_IMAGE_LIFETIME_MS + 1;
  const swept = await sweepImages(harness.deps, harness.logger, later);
  t.is(swept.deleted, 1);
  t.is(images.get(harness.db, user.id, pending.id), null);
  t.false(existsSync(pendingPath));
  t.false(existsSync(thumbnailPath(pendingPath)));
  t.false(existsSync(stray));
  t.true(existsSync(attachedPath));
  t.true(existsSync(thumbnailPath(attachedPath)));
});
