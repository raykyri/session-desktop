import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResearchImageAttachment, ResearchTweetAttachment } from "../src/types";
import {
  acceptResearchImageFiles,
  RESEARCH_IMAGE_COUNT_ERROR,
  RESEARCH_IMAGE_MAX_BYTES,
  RESEARCH_IMAGE_SIZE_ERROR,
  RESEARCH_IMAGE_TYPE_ERROR,
  researchImageAlt,
  researchImageBlockReason,
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
  assert.deepEqual(acceptResearchImageFiles([file("image/gif", RESEARCH_IMAGE_MAX_BYTES + 1)], 0), {
    accepted: [],
    error: RESEARCH_IMAGE_SIZE_ERROR,
  });
  assert.deepEqual(acceptResearchImageFiles([file("image/png"), file("image/png")], 7), {
    accepted: [file("image/png")],
    error: RESEARCH_IMAGE_COUNT_ERROR,
  });
});

test("images are labelled by count and named by file name", () => {
  assert.equal(researchImageLabel(0), null);
  assert.equal(researchImageLabel(1), "[Image]");
  assert.equal(researchImageLabel(3), "[3 images]");
  assert.equal(researchImageAlt(image("1", "Screenshot.png")), "Screenshot.png");
  assert.equal(researchImageAlt(image("1")), "Image");
  assert.deepEqual(researchImages([unavailableTweet, image("2")]), [image("2")]);
});

test("only agents without image input block a message with images", () => {
  assert.equal(researchImageBlockReason("claude", "Claude", 2), null);
  assert.equal(researchImageBlockReason("codex", "Codex", 1), null);
  assert.equal(researchImageBlockReason("grok", "Grok CLI", 1), "Grok CLI can't read images.");
  assert.equal(researchImageBlockReason("grok", null, 1), "Grok can't read images.");
  assert.equal(researchImageBlockReason("grok", "Grok", 0), null);
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

test("a stored queued question keeps its well-formed images", async () => {
  const stored = {
    tree: {
      scrollByNode: {},
      queuedFollowups: {
        root: [
          {
            id: "q-1",
            prompt: "Compare these",
            createdAt: 5,
            images: [image("1", "One.png"), { kind: "image", id: 7 }, { kind: "tweet" }],
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
  assert.deepEqual(researchNavigationStore().tree?.queuedFollowups?.root, [
    { id: "q-1", prompt: "Compare these", createdAt: 5, images: [image("1", "One.png")] },
    { id: "q-2", prompt: "No images", createdAt: 6 },
  ]);
});
