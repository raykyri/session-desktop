// Unsent text: the "Discard …?" dialog (the mockup's ask-discard and the
// composer's discard), and the leave guard that shows it when the person
// goes to another screen (a link, Back) with text they have not sent.

import { useBlocker } from "@tanstack/react-router";

import { Modal } from "./Page.js";

export function DiscardDialog({
  title,
  onKeep,
  onDiscard,
  back = true,
}: {
  title: string;
  onKeep: () => void;
  onDiscard: () => void;
  back?: boolean;
}) {
  return (
    <Modal
      title={title}
      role="alertdialog"
      className="sm"
      bare
      back={back}
      onClose={onKeep}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onKeep}>
            Keep editing
          </button>
          <button className="btn danger" type="button" onClick={onDiscard}>
            Discard
          </button>
        </>
      }
    >
      <p className="muted">The text you wrote will be deleted.</p>
    </Modal>
  );
}

/** While `when`, leaving the screen asks first: Keep editing stays, Discard
 * goes on to where the person was going. A reload or a closed tab gets the
 * browser's own question. */
export function LeaveGuard({ when, title }: { when: boolean | (() => boolean); title: string }) {
  const on = typeof when === "function" ? when : () => when;
  const b = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      on() &&
      (current.pathname !== next.pathname ||
        JSON.stringify(current.search) !== JSON.stringify(next.search)),
    enableBeforeUnload: on,
    withResolver: true,
  });
  if (b.status !== "blocked") return null;
  return (
    <DiscardDialog
      title={title}
      back={false}
      onKeep={() => b.reset()}
      onDiscard={() => b.proceed()}
    />
  );
}
