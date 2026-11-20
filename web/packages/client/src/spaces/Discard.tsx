// Unsent text: the "Discard …?" dialog (the mockup's ask-discard and the
// composer's discard), and the leave guard that shows it when the person
// goes to another screen (a link, Back) with text they have not sent.

import { useBlocker } from "@tanstack/react-router";

import { DiscardDialog } from "./Page.js";

export { DiscardDialog };

/** While `when`, leaving the screen asks first: Keep editing stays, Discard
 * runs `onDiscard` (the screen drops its draft, and a create with no answer
 * is forgotten) and goes on to where the person was going. A reload or a
 * closed tab gets the browser's own question. */
export function LeaveGuard({
  when,
  title,
  body,
  onDiscard,
}: {
  when: boolean | (() => boolean);
  title: string;
  body?: string;
  onDiscard?: () => void;
}) {
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
      {...(body !== undefined ? { body } : {})}
      back={false}
      onKeep={() => b.reset()}
      onDiscard={() => {
        onDiscard?.();
        b.proceed();
      }}
    />
  );
}
