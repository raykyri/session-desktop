import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchPostColumn from "../src/components/research/ResearchPostColumn";
import { researchMenuPoint } from "../src/components/research/ResearchMenu";
import { ResearchThreadMenu } from "../src/components/research/ResearchThreadMenu";
import { researchStrip, type ResearchColumn } from "../src/lib/researchColumns";
import { nodePrompt } from "../src/lib/researchNodeTypes";
import type { ResearchNode, ResearchTreeDetail } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";
import { withWidgetDom } from "./widgetDom";

// Registered before the note columns are pulled in, since the follow-ups
// column's composer shows adapter icons.
register("./svgStubLoader.mjs", import.meta.url);
const { ResearchNoteColumn } = await import("../src/components/research/ResearchNoteColumns");

const noop = () => {};

const postFields = {
  id: "post", treeId: "tree", prompt: "Who ships component-model plugins?",
  adapter: "claude", model: "fable", groupId: "ws", type: "post", format: "text",
  status: "complete", createdAt: 100, highlights: [],
  delivery: { status: "posted", postedAt: 100 },} satisfies NodeFixture;
const post = researchNode(postFields);

function render(nodes: ResearchNode[], selected: ResearchNode = nodes[0]) {
  const detail: ResearchTreeDetail = {
    tree: {
      id: "tree", title: "Who ships component-model plugins?", rootNodeId: "post",
      workspaceId: "ws", createdAt: 100, updatedAt: 100,
    },
    nodes,
  };
  return renderToStaticMarkup(createElement(ResearchPostColumn, { detail, post: selected, onSelectNode: noop }));
}

test("a note's column uses the turn layout for the note only", () => {
  const html = render([post]);
  assert.doesNotMatch(html, /post-kind/);
  // Use the turn's question section for the post, with no answer section.
  assert.match(html, /<article class="research-turn post-turn">/);
  assert.match(html, /class="research-turn-question"/);
  assert.match(html, /research-prompt research-turn-prompt"/);
  assert.doesNotMatch(html, /research-turn-answer|post-status|Posted to your network|No replies yet/);
  // The column header contains the title and history, so the body repeats
  // neither; follow-ups and the composer are in the follow-ups column.
  assert.doesNotMatch(html, /research-thread-actions|research-breadcrumb/);
  assert.doesNotMatch(html, /research-composer|post-thread/);
});

test("a note's column shows no stored replies or follow-ups", () => {
  const withActivityFields = {
    ...postFields,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{
        id: "r1", author: { kind: "member", id: "ben", displayName: "Ben Kowalski" },
        body: "wit-bindgen doubled our SDK surface.", createdAt: 110,
      }],
    },} satisfies NodeFixture;
  const withActivity = researchNode(withActivityFields);
  const followUpFields = {
    ...postFields, id: "net", parentNodeId: "post", prompt: "Anyone measured wizer?", createdAt: 140,} satisfies NodeFixture;
  const followUp = researchNode(followUpFields);
  const html = render([withActivity, followUp]);
  assert.doesNotMatch(html, />Activity|post-group/);
  assert.doesNotMatch(html, /wit-bindgen doubled|Anyone measured wizer/);
});

test("a follow-up note's page links back to its parent note", () => {
  const childFields = {
    ...postFields, id: "net", parentNodeId: "post", prompt: "Anyone measured wizer?", createdAt: 140,} satisfies NodeFixture;
  const child = researchNode(childFields);
  const html = render([post, child], child);
  assert.match(html, /↳ Follow-up to “Who ships component-model plugins\?”/);
  assert.doesNotMatch(html, /network/i);
  assert.doesNotMatch(html, /research-thread-actions/);
});

test("a saved link's post column shows the link card", () => {
  const linkFields = {
    ...postFields,
    prompt: "https://example.com/page",
    format: "link",
    delivery: null,} satisfies NodeFixture;
  const link = researchNode(linkFields);
  const html = render([link]);
  assert.match(html, /post-link-card/);
  assert.doesNotMatch(html, /Saved the link|No replies yet/);
});

test("a post renders by its stored format, not by parsing its text", () => {
  const askedFields = { ...postFields, prompt: "https://example.com/page", format: "text" } satisfies NodeFixture;
  const asked = researchNode(askedFields);
  assert.doesNotMatch(render([asked]), /post-link-card/);
});


test("an edited post shows its text in place and Edited after its time", () => {
  const edited = researchNode({
    ...postFields,
    prompt: "Who ships wit-bindgen plugins?",
    editedAt: 200,
    delivery: {
      status: "posted", postedAt: 100,
      replies: [{
        id: "r1", author: { kind: "member", id: "ben", displayName: "Ben Kowalski" },
        body: "We do.", createdAt: 110,
      }],
    },
  });
  const html = render([edited]);
  assert.match(html, /Who ships wit-bindgen plugins\?/);
  assert.match(html, /<div class="research-turn-meta research-post-meta"><time [^>]*>[^<]+<\/time><span aria-hidden="true">·<\/span><span title="Edited [^"]+">Edited<\/span><\/div>/);
  assert.doesNotMatch(html, /[Cc]orrection/);
  // An unedited post has no Edited mark.
  assert.doesNotMatch(render([post]), /Edited/);
});

const followUpNoteFields = {
  ...postFields, id: "net", parentNodeId: "post", prompt: "Anyone measured wizer?", createdAt: 140, delivery: null,
} satisfies NodeFixture;
const followUpNote = researchNode(followUpNoteFields);
const followUpDetail: ResearchTreeDetail = {
  tree: {
    id: "tree", title: "Who ships component-model plugins?", rootNodeId: "post",
    workspaceId: "ws", createdAt: 100, updatedAt: 100,
  },
  nodes: [post, followUpNote],
};

test("every note level's column has the Note actions … button in its header", () => {
  const strip = researchStrip(followUpDetail.nodes, "net", null);
  const columns = strip.columns.filter(
    (column): column is Extract<ResearchColumn, { role: "post" }> => column.role === "post",
  );
  assert.deepEqual(columns.map((column) => column.id), ["N0", "N1"]);
  for (const column of columns) {
    const followUp = column.level.index === 1;
    const note = followUp ? followUpNote : post;
    const html = renderToStaticMarkup(
      createElement(ResearchNoteColumn, {
        column, current: false, detail: followUpDetail, post: note, title: nodePrompt(note),
        history: null, archived: false, menu: { open: followUp, onOpen: noop, onContextMenu: noop },
        scrollRef: undefined, onSelectNode: noop,
      }),
    );
    assert.match(html, new RegExp(`data-research-column="${column.id}"`));
    assert.match(
      html,
      new RegExp(
        `class="control-button research-head-button research-head-menu" aria-label="Note actions" title="Note actions" aria-haspopup="menu" aria-expanded="${followUp}"`,
      ),
    );
  }
});

/** The labels of the open menu's items in order, "|" for a separator, with
 * " (disabled)" after a disabled item. */
function openMenuOutline(document: Document): string[] {
  return [...document.querySelectorAll("[role='menu'] [role^='menuitem'], [role='menu'] [role='separator']")].map(
    (item) =>
      item.getAttribute("role") === "separator"
        ? "|"
        : `${item.querySelector(".research-menu-label")?.textContent ?? ""}${
            item.getAttribute("data-shortcut") ? ` [${item.getAttribute("data-shortcut")}]` : ""
          }${item.hasAttribute("disabled") ? " (disabled)" : ""}`,
  );
}

async function noteMenuOutline(nodeId: string, options: { archived?: boolean; nodes?: ResearchNode[] } = {}) {
  let outline: string[] = [];
  await withWidgetDom(async (window) => {
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    const nodes = options.nodes ?? followUpDetail.nodes;
    await act(async () =>
      root.render(
        createElement(ResearchThreadMenu, {
          menu: { kind: "post", nodeId, anchor: researchMenuPoint(10, 10), align: "point" },
          nodes, nodeById: new Map(nodes.map((node) => [node.id, node])), treeNodes: nodes,
          rootNodeId: "post", treeTitle: "Who ships component-model plugins?", archived: options.archived ?? false,
          content: null, view: null, hiddenHighlights: 0, fullTrace: false, openBranchIds: new Set<string>(),
          relaunchPending: false, isPassagePress: () => false, onClose: noop, onOpenBranch: noop, onBranch: noop,
          onRemoveHighlight: noop, onEdit: noop, onShowFullTrace: noop, onToggleFullTrace: noop,
          onCopyAnswer: noop, onCopyNote: noop, onCopyThread: noop, onRerun: noop, onGenerateRecap: noop,
          onRename: noop, onDelete: noop,
        }),
      ),
    );
    outline = openMenuOutline(window.document);
    await act(async () => root.unmount());
  });
  return outline;
}

test("a follow-up note's menu edits, copies and deletes the note (D); the root note's has no Delete", async () => {
  assert.deepEqual(await noteMenuOutline("net"), ["Edit note", "Copy note", "|", "Delete note [d]"]);
  // A running AI follow-up under the note prevents deleting the note by itself.
  const running = researchNode({
    ...postFields, id: "ask", parentNodeId: "net", type: "exchange", status: "running", createdAt: 160, delivery: null,
  });
  assert.deepEqual(
    await noteMenuOutline("net", { nodes: [post, followUpNote, running] }),
    ["Edit note", "Copy note", "|", "Delete note [d] (disabled)"],
  );
  assert.deepEqual(await noteMenuOutline("net", { archived: true }), [
    "Edit note (disabled)", "Copy note", "|", "Delete note [d]",
  ]);
  // The root note represents the thread, which is deleted from the feed.
  assert.deepEqual(await noteMenuOutline("post"), ["Edit note", "Copy note"]);
});
