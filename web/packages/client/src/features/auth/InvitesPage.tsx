// Invites (02 W7.1, the mockup's `membersPage`): the invite tree on the left
// and "Invite someone" beside it (one column at 860 px and below). Both are
// online-only reads (`members.tree`, `accountInvites.list`). An account that
// was deleted (`handle: null`) reads "Deleted account" with the neutral
// avatar, as its content does elsewhere.

import { inviteLimitMessage } from "@session/shared";

import { useMe } from "../../api/account.js";
import {
  useAccountInvites,
  useCreateInviteLink,
  useMembersTree,
  useRevokeInviteLink,
} from "../../api/membership.js";
import { COPY_FAILED, writeClipboardText } from "../../lib/clipboard.js";
import { cn } from "../../lib/cn.js";
import { Avatar } from "../../ui/Avatar.js";
import { authorName } from "../feed/format.js";
import { CloseIcon } from "../feed/icons.js";
import { PageFrame } from "../shell/Frames.js";
import { showToast } from "../shell/Toast.js";

export interface TreeNodeView {
  id: string;
  handle: string | null;
  displayName: string | null;
  invitedBy: string | null;
  joinedAt: number;
  staff: "admin" | null;
}

/** The tree's rows, depth-first from the roots with children by join date
 * (the mockup's `treeRows`). An account whose inviter is not in the list is
 * a root. */
export function treeRows<T extends TreeNodeView>(
  nodes: readonly T[],
): { node: T; depth: number }[] {
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string | null, T[]>();
  for (const node of nodes) {
    const parent = node.invitedBy !== null && ids.has(node.invitedBy) ? node.invitedBy : null;
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  }
  const rows: { node: T; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const node of children.get(parent) ?? []) {
      rows.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

const ROW = 40;
const indent = (depth: number) => 8 + depth * 18;

function InviteTree({ meId }: { meId: string | null }) {
  const tree = useMembersTree();
  if (tree.isPending) {
    return <p className="fine">Loading the invite tree…</p>;
  }
  if (tree.isError) {
    return <p className="ferr">The invite tree could not be loaded.</p>;
  }
  const rows = treeRows(tree.data);
  const index = new Map(rows.map((row, position) => [row.node.id, position]));
  const paths = rows.flatMap(({ node, depth }, position) => {
    const parent = node.invitedBy === null ? undefined : index.get(node.invitedBy);
    if (depth === 0 || parent === undefined) return [];
    const x = indent(depth - 1);
    const y = position * ROW + ROW / 2;
    const top = parent * ROW + ROW / 2 + 11;
    return [
      <path
        key={node.id}
        d={`M${x} ${top} L${x} ${y - 6} Q${x} ${y} ${x + 6} ${y} L${indent(depth) - 11} ${y}`}
      />,
    ];
  });
  return (
    <div className="ttree" role="list" aria-label="Invite tree">
      <svg height={rows.length * ROW} aria-hidden="true">
        {paths}
      </svg>
      {rows.map(({ node, depth }) => (
        <div
          key={node.id}
          role="listitem"
          aria-level={depth + 1}
          className={cn("trow", node.id === meId && "me", node.handle === null && "gone")}
          style={{ paddingLeft: indent(depth) - 10 }}
        >
          <Avatar handle={node.handle} size="sm" />
          <span className="tn">
            <b>
              {authorName(node.handle)}
              {node.staff === "admin" ? <span className="trole"> · Admin</span> : null}
            </b>
            {node.displayName ? <small>{node.displayName}</small> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

const joined = (at: number) =>
  `Joined ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

function InviteBox() {
  const invites = useAccountInvites();
  const create = useCreateInviteLink();
  const revoke = useRevokeInviteLink();
  if (invites.isPending) return <section className="invbox">Loading…</section>;
  if (invites.isError) {
    return (
      <section className="invbox">
        <p className="ferr">Your invites could not be loaded.</p>
      </section>
    );
  }
  const view = invites.data;
  const open = view.links.filter((link) => link.state === "open");
  // null for site admins, who have no invite limit (04 I2)
  const allowance = view.allowance;
  const canCreate = allowance === null || allowance.left > 0;
  return (
    <section className="invbox" aria-labelledby="inv-h">
      <div className="ishead">
        <h3 id="inv-h">Invite someone</h3>
        <small>
          {allowance === null
            ? `${view.openCount} open`
            : `${allowance.left} of ${allowance.total} left`}
        </small>
      </div>
      {open.map((link) => (
        <div key={link.id} className="ilink">
          <code>{link.link ?? "Code unavailable"}</code>
          {link.link ? (
            <button
              type="button"
              className="btn1 sm"
              onClick={() => {
                void writeClipboardText(link.link ?? "").then(
                  () => showToast("Link copied."),
                  () => showToast(COPY_FAILED, { alert: true }),
                );
              }}
            >
              Copy
            </button>
          ) : null}
          <button
            type="button"
            className="ibtn"
            aria-label="Revoke this link"
            title="Revoke"
            disabled={revoke.isPending}
            onClick={() =>
              revoke.mutate(link.id, {
                onSuccess: () => showToast("Invite revoked."),
                onError: (failure) => showToast(failure.message, { alert: true }),
              })
            }
          >
            <CloseIcon />
          </button>
        </div>
      ))}
      {canCreate ? (
        <button
          type="button"
          className={`${open.length > 0 ? "btn2" : "btn1"} wide`}
          disabled={create.isPending}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: (made) =>
                showToast(`Invite ${made.code} created. Send the link to one person.`),
              onError: (failure) => showToast(failure.message, { alert: true }),
            })
          }
        >
          {open.length > 0 ? "Create a new link" : "Create an invite link"}
        </button>
      ) : (
        <p className="fine">{inviteLimitMessage(allowance.total)}</p>
      )}
      {view.invited.length > 0 ? (
        <>
          <h4>You invited</h4>
          <div className="ippl">
            {view.invited.map((person) => (
              <div key={`${person.handle ?? ""}:${person.joinedAt}`} className="ip">
                <Avatar handle={person.handle} size="xs" />
                <b>{authorName(person.handle)}</b>
                <span className="grow" />
                <small>{joined(person.joinedAt)}</small>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function InvitesPage() {
  const me = useMe().data ?? null;
  return (
    <PageFrame title="Invites">
      <div className="mcols">
        <div className="mmain">
          <section aria-labelledby="tree-h">
            <h3 id="tree-h">Invite tree</h3>
            <p className="tcopy">
              Session is invite-only. You can have 3 open invite links at a time. Each link works
              for one person. A slot frees when a link is used or revoked.
            </p>
            <InviteTree meId={me?.id ?? null} />
          </section>
        </div>
        <aside className="mside">
          <InviteBox />
        </aside>
      </div>
    </PageFrame>
  );
}
