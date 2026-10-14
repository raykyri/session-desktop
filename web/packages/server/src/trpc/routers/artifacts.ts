// `artifacts`: widget pages, revisions and saved inputs
// (`03-api-and-events.md` §2, `11-artifacts-and-browser.md` §3). The desktop's
// `research_widget_prepare`, `research_artifact_register`,
// `research_artifact_history`, `research_artifact_state_get` and
// `research_artifact_state_update`.
//
// Every HTML these procedures serve or record comes from a stored answer the
// caller can read: a client names a block, it never supplies the HTML that is
// served. Saved inputs are per person.

import { trees, widgets } from "@session/db";
import type { ResearchArtifactRevision } from "@session/shared";
import { sessionWidgetMetadata } from "@session/shared";
import { isActiveResearchStatus } from "@session/shared/lib/researchChains";
import { nodeStatus } from "@session/shared/lib/researchNodeTypes";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  answerWidgetBlocks,
  answerWidgetSource,
  normalizeWidgetHtml,
} from "../../artifacts/answerBlocks.js";
import { mintWidgetPreview } from "../../artifacts/widgets.js";
import { nodeContent } from "../../research/admission.js";
import { budgetedProcedure, router } from "../base.js";
import { repo } from "../errors.js";

/** Signed in, with the `widgets` budget instead of the general mutation
 * budget: one thread can show many widgets. */
const widgetProcedure = budgetedProcedure(
  "widgets",
  "too many widget requests at once; try again in a moment",
);

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(256);
const reference = z.object({ treeId: id, artifactId: id, revision: hash });

/** The tree, if `userId` may read it; NOT_FOUND otherwise. */
function readableTree(
  ctx: { db: Parameters<typeof trees.get>[0] },
  userId: string,
  treeId: string,
) {
  const tree = repo(() => trees.get(ctx.db, userId, treeId));
  if (tree === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: `research tree ${treeId} was not found` });
  }
  return tree;
}

/** The stored revision `input` names in a tree `userId` can read. */
function readableRevision(
  ctx: { db: Parameters<typeof trees.get>[0] },
  userId: string,
  input: z.infer<typeof reference>,
): ResearchArtifactRevision {
  readableTree(ctx, userId, input.treeId);
  const revision = widgets.get(ctx.db, input);
  if (revision === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "widget revision was not found" });
  }
  return revision;
}

export const artifactsRouter = router({
  /**
   * One-hour page URLs for a widget: a block of a stored answer named by the
   * SHA-256 of its HTML, or a stored revision (the revision list's preview).
   * `runUrl` is null while widget scripts are off (`artifacts/site.ts`).
   */
  prepareWidget: widgetProcedure
    .input(z.union([z.object({ nodeId: id, sha256: hash }), reference]))
    .mutation(({ ctx, input }) => {
      let html: string | null;
      if ("nodeId" in input) {
        html = answerWidgetSource(nodeContent(ctx, input.nodeId), input.sha256);
        if (html === null)
          throw new TRPCError({ code: "NOT_FOUND", message: "Widget not found in this answer" });
      } else {
        html = readableRevision(ctx, ctx.user.id, input).html;
      }
      const minted = mintWidgetPreview(ctx.db, ctx.user.id, html, {
        scripts: ctx.config.widgetScripts.allowed,
      });
      const origin = ctx.config.artifactOrigin;
      return {
        staticUrl: `${origin}/w/${minted.staticToken}`,
        runUrl: minted.runToken === null ? null : `${origin}/w/${minted.runToken}`,
        expiresAt: minted.expiresAt,
      };
    }),

  /**
   * Stores the revision of a displayed widget and returns it. The block must
   * be a complete widget of the node's stored answer with this HTML and fence
   * metadata; the id, title and parent come from that metadata.
   */
  register: widgetProcedure
    .input(
      z.object({
        nodeId: id,
        slot: z.string().max(256),
        html: z.string().max(256 * 1024),
        meta: z.string().max(4096),
      }),
    )
    .mutation(({ ctx, input }): ResearchArtifactRevision => {
      const content = nodeContent(ctx, input.nodeId);
      const html = normalizeWidgetHtml(input.html);
      const meta = input.meta.trim();
      const block = answerWidgetBlocks(content).find(
        (candidate) => normalizeWidgetHtml(candidate.html) === html && candidate.meta === meta,
      );
      if (!block) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Widget not found in this answer" });
      }
      return repo(() =>
        widgets.register(ctx.db, {
          treeId: content.node.treeId,
          nodeId: input.nodeId,
          slot: input.slot,
          ...sessionWidgetMetadata(block.meta),
          html: block.html,
        }),
      );
    }),

  /**
   * The artifact's revisions in lineage order, after storing every named
   * revision of it found in the thread's settled answers (the desktop's
   * `index_research_artifact`). `unresolved` counts sources that could not
   * be stored.
   */
  history: widgetProcedure
    .input(z.object({ treeId: id, artifactId: id }))
    .query(({ ctx, input }) => {
      readableTree(ctx, ctx.user.id, input.treeId);
      const detail = repo(() => trees.detail(ctx.db, ctx.user.id, input.treeId));
      let unresolved = 0;
      for (const node of detail.nodes) {
        if (isActiveResearchStatus(nodeStatus(node))) continue;
        for (const block of answerWidgetBlocks(nodeContent(ctx, node.id), input.artifactId)) {
          const metadata = sessionWidgetMetadata(block.meta);
          if (metadata.artifactId !== input.artifactId) continue;
          try {
            widgets.register(ctx.db, {
              treeId: input.treeId,
              nodeId: node.id,
              slot: `source:${block.offset}`,
              ...metadata,
              html: block.html,
            });
          } catch {
            unresolved += 1;
          }
        }
      }
      return {
        revisions: repo(() => widgets.history(ctx.db, input.treeId, input.artifactId)),
        unresolved,
      };
    }),

  /** The caller's saved inputs for a revision. */
  getState: widgetProcedure.input(reference).query(({ ctx, input }) => {
    readableTree(ctx, ctx.user.id, input.treeId);
    return repo(() => widgets.getState(ctx.db, ctx.user.id, input));
  }),

  /** Applies one saved-input action for the caller (`repos/widgets.ts`). */
  updateState: widgetProcedure
    .input(
      z.object({
        reference,
        action: z.enum(["enable", "disable", "save", "reset", "migrate"]),
        value: z.unknown().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      readableTree(ctx, ctx.user.id, input.reference.treeId);
      return repo(() =>
        widgets.updateState(
          ctx.db,
          ctx.user.id,
          input.reference,
          input.action,
          input.value ?? null,
        ),
      );
    }),
});
