import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResearchImageAttachment, ResearchTweetAttachment } from "../src/types";
import {
  acceptResearchImageFiles,
  RESEARCH_IMAGE_COUNT_ERROR,
  RESEARCH_IMAGE_MAX_BYTES,
  RESEARCH_IMAGE_MAX_UNSCALED_BYTES,
  RESEARCH_IMAGE_SIZE_ERROR,
  RESEARCH_IMAGE_TYPE_ERROR,
  RESEARCH_IMAGE_UNSCALED_SIZE_ERROR,
  RESEARCH_MESSAGE_IMAGE_SIZE_ERROR,
  researchImageAlt,
  researchImageBlockReason,
  pasteAttachesImages,
  researchDropKey,
  researchImageLabel,
  researchImages,
} from "../src/lib/researchImages";
import { ResearchMessageBody, visibleResearchPrompt } from "../src/components/research/ResearchMessage";
import ResearchConversationComposer from "../src/components/research/ResearchConversationComposer";

const image = (id: string, fileName?: string): ResearchImageAttachment => ({
  kind: "image",
  id: `${id.padStart(32, "0")}.png`,
  mimeType: "image/png",
  byteSize: 2048,
  width: 640,
  height: 480,
  ...(fileName ? { fileName } : {}),
});

const unavailableTweet: ResearchTweetAttachment = {
  kind: "tweet",
  schemaVersion: 1,
  sourceUrl: "https://x.com/a/status/1",
  tweetId: "1",
  placement: "trailing",
  provider: "xSyndication",
  status: "unavailable",
  attemptedAt: 1,
  failure: "notFound",
};

test("a composer takes PNG, JPEG, GIF and WebP files up to the size and count limits", () => {
  const file = (type: string, size = 10) => ({ type, size });
  assert.deepEqual(acceptResearchImageFiles([file("image/png"), file("image/webp")], 0), {
    accepted: [file("image/png"), file("image/webp")],
    error: null,
  });
  assert.deepEqual(acceptResearchImageFiles([file("image/svg+xml"), file("image/jpeg")], 0), {
    accepted: [file("image/jpeg")],
    error: RESEARCH_IMAGE_TYPE_ERROR,
  });
  assert.deepEqual(acceptResearchImageFiles([file("image/png", RESEARCH_IMAGE_MAX_BYTES + 1)], 0), {
    accepted: [],
    error: RESEARCH_IMAGE_SIZE_ERROR,
  });
  // PNG and JPEG files over 5 MB are downscaled by the backend; GIF and
  // WebP files are not.
  const large = RESEARCH_IMAGE_MAX_UNSCALED_BYTES + 1;
  assert.deepEqual(acceptResearchImageFiles([file("image/jpeg", large), file("image/gif", large)], 0), {
    accepted: [file("image/jpeg", large)],
    error: RESEARCH_IMAGE_UNSCALED_SIZE_ERROR,
  });
  assert.deepEqual(acceptResearchImageFiles([file("image/png"), file("image/png")], 7), {
    accepted: [file("image/png")],
    error: RESEARCH_IMAGE_COUNT_ERROR,
  });
});

test("a paste attaches its images unless it carries text of its own", () => {
  // A screenshot, an image copied with its URL, and Finder files.
  assert.equal(pasteAttachesImages("", ["image.png"]), true);
  assert.equal(pasteAttachesImages("https://example.com/a.png", ["image.png"]), true);
  assert.equal(
    pasteAttachesImages("Screen Shot 1.png\nScreen Shot 2.png", ["Screen Shot 1.png", "Screen Shot 2.png"]),
    true,
  );
  // An image copied from a page: its HTML is one <img>.
  assert.equal(
    pasteAttachesImages("Alt text", ["image.png"], '<meta charset="utf-8"><img src="https://example.com/a.png" alt="Alt text">'),
    true,
  );
  // Cells, a single cell or word, or a document paste as text even with
  // their rendered image.
  assert.equal(pasteAttachesImages("Revenue\t2024\n12\t14", ["image.png"]), false);
  assert.equal(pasteAttachesImages("A sentence copied from a page", ["image.png"]), false);
  assert.equal(pasteAttachesImages("Revenue", ["image.png"], "<table><tr><td>Revenue</td></tr></table>"), false);
  assert.equal(pasteAttachesImages("1234", ["image.png"]), false);
  assert.equal(pasteAttachesImages("Logo", ["image.png"], '<p>Logo <img src="a.png"></p>'), false);
});

test("a DOM drop and the native drop of the same files compare equal", () => {
  assert.equal(researchDropKey(["b.png", "a.png"]), researchDropKey(["/Users/me/a.png", "/Users/me/b.png"]));
  assert.notEqual(researchDropKey(["a.png"]), researchDropKey(["/Users/me/c.png"]));
});

test("images are labelled by count and named by file name", () => {
  assert.equal(researchImageLabel(0), null);
  assert.equal(researchImageLabel(1), "[Image]");
  assert.equal(researchImageLabel(3), "[3 images]");
  assert.equal(researchImageAlt(image("1", "Screenshot.png")), "Screenshot.png");
  assert.equal(researchImageAlt(image("1")), "Image");
  assert.deepEqual(researchImages([unavailableTweet, image("2")]), [image("2")]);
});

test("agents without image input and oversized messages block a message with images", () => {
  const two = [image("1"), image("2")];
  assert.equal(researchImageBlockReason("claude", "Claude", two), null);
  assert.equal(researchImageBlockReason("codex", "Codex", [image("1")]), null);
  assert.equal(researchImageBlockReason("grok", "Grok CLI", [image("1")]), "Grok CLI can't read images.");
  assert.equal(researchImageBlockReason("grok", null, [image("1")]), "Grok can't read images.");
  assert.equal(researchImageBlockReason("grok", "Grok", []), null);
  const big = (id: string) => ({ ...image(id), byteSize: 5 * 1024 * 1024 });
  assert.equal(researchImageBlockReason("claude", "Claude", ["1", "2", "3", "4"].map(big)), null);
  assert.equal(
    researchImageBlockReason("claude", "Claude", ["1", "2", "3", "4", "5"].map(big)),
    RESEARCH_MESSAGE_IMAGE_SIZE_ERROR,
  );
});

test("a message shows its images as thumbnails, and a Home card as a label", () => {
  const attachments = [image("1", "One.png"), image("2", "Two.png")];
  const body = renderToStaticMarkup(
    createElement(ResearchMessageBody, { prompt: "What is this?", attachments }),
  );
  assert.match(body, /class="research-image-strip research-message-images has-prompt"/);
  assert.match(body, /aria-label="Open image: One.png"/);
  assert.match(body, /aria-label="Open image: Two.png"/);
  assert.doesNotMatch(body, /Remove image/);

  const card = renderToStaticMarkup(
    createElement(ResearchMessageBody, { prompt: "What is this?", attachments, tweetLabels: true }),
  );
  assert.match(card, /<p class="research-message-tweet-labels">\[2 images\]<\/p>/);
  assert.doesNotMatch(card, /research-image-strip/);
  // Images never change the visible prompt text.
  assert.equal(visibleResearchPrompt("Look", attachments), "Look");
});

test("a composer lists its images with remove buttons and blocks an agent that can't read them", () => {
  const render = (imageBlockReason: string | null) =>
    renderToStaticMarkup(
      createElement(ResearchConversationComposer, {
        value: "Why?",
        placeholder: "Ask a follow-up",
        disabled: false,
        canSubmit: true,
        submitting: false,
        requireCmdEnter: true,
        images: [image("1", "Shot.png")],
        onImagesChange: () => {},
        imageBlockReason,
        onChange: () => {},
        onSubmit: () => {},
      }),
    );
  const ready = render(null);
  assert.match(ready, /aria-label="Remove image: Shot.png"/);
  assert.match(ready, /<button class="control-button research-composer-send" type="submit" aria-label="Send"/);
  const blocked = render("Grok can't read images.");
  assert.match(blocked, /role="alert">Grok can(&#x27;|')t read images.<\/p>/);
  assert.match(blocked, /type="submit" disabled=""/);
});

test("queued questions an earlier build stored move to the backend once, with their well-formed images", async () => {
  const stored = {
    tree: {
      scrollByNode: {},
      selectedNodeId: "root",
      queuedFollowups: {
        root: [
          {
            id: "q-1",
            prompt: "Compare these",
            createdAt: 5,
            images: [image("1", "One.png"), { kind: "image", id: 7 }, { kind: "tweet" }],
            failed: "Refused before the restart",
          },
          { id: "q-2", prompt: "No images", createdAt: 6 },
        ],
      },
    },
  };
  const values = new Map([["session.research-navigation.v1", JSON.stringify(stored)]]);
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const { researchNavigationStore } = await import("../src/lib/researchNavigation");
  const { migrateLegacyResearchQueues } = await import("../src/lib/researchQueue");
  assert.deepEqual(researchNavigationStore().tree?.queuedFollowups?.root, [
    { id: "q-1", prompt: "Compare these", createdAt: 5, images: [image("1", "One.png")] },
    { id: "q-2", prompt: "No images", createdAt: 6 },
  ]);

  // A failed handover keeps the stored queue for the next start.
  await assert.rejects(
    migrateLegacyResearchQueues(async () => {
      throw new Error("backend unavailable");
    }),
  );
  assert.equal(researchNavigationStore().tree?.queuedFollowups?.root?.length, 2);

  const sent: unknown[] = [];
  await migrateLegacyResearchQueues(async (items) => {
    sent.push(...items);
    return items.length;
  });
  assert.deepEqual(sent, [
    { id: "q-1", headNodeId: "root", prompt: "Compare these", createdAt: 5, images: [image("1", "One.png")] },
    { id: "q-2", headNodeId: "root", prompt: "No images", createdAt: 6, images: [] },
  ]);
  // The stored copy is gone; the thread's other state stays.
  assert.equal(researchNavigationStore().tree?.queuedFollowups, undefined);
  const saved = JSON.parse(values.get("session.research-navigation.v1") ?? "{}");
  assert.equal(saved.tree.queuedFollowups, undefined);
  assert.equal(saved.tree.selectedNodeId, "root");

  // Nothing is left to hand over.
  let calls = 0;
  await migrateLegacyResearchQueues(async () => {
    calls++;
  });
  assert.equal(calls, 0);
});

test("a thread's ask box images are stored with its navigation for a day", async () => {
  const navigation = await import("../src/lib/researchNavigation");
  const boxes = { root: [image("1", "One.png")], "pending:n1": [image("2")] };
  navigation.recordResearchComposerImages("tree-images", boxes, 1_000);
  assert.deepEqual(navigation.savedResearchComposerImages("tree-images", 2_000), boxes);
  const stored = JSON.parse(localStorage.getItem("session.research-navigation.v1") ?? "{}");
  assert.deepEqual(stored["tree-images"].composerImages, { images: boxes, updatedAt: 1_000 });
  // The backend removes pending images after a day.
  assert.deepEqual(
    navigation.savedResearchComposerImages("tree-images", 1_000 + navigation.RESEARCH_COMPOSER_IMAGES_TTL_MS),
    {},
  );
  navigation.recordResearchComposerImages("tree-images", {});
  assert.deepEqual(navigation.savedResearchComposerImages("tree-images"), {});
  // Deleting the tree removes them with the rest of its navigation.
  navigation.recordResearchComposerImages("tree-images", boxes);
  navigation.pruneResearchNavigation([]);
  assert.deepEqual(navigation.savedResearchComposerImages("tree-images"), {});
});
