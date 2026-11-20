// Composer drafts belong to one account (02 §9.4): another account's drafts
// are dropped, a tab without a session cannot read them, sign-out clears
// them.

import test from "ava";

import { claimDrafts, resetDrafts, useDraftsStore } from "../src/stores/drafts.js";
import { claimLocalAccountState, clearLocalAccountState } from "../src/stores/localAccount.js";

test.beforeEach(() => {
  sessionStorage.clear();
  resetDrafts(undefined);
});

test.serial("an account's drafts are kept for it and dropped for another", (t) => {
  claimLocalAccountState("u1");
  useDraftsStore.getState().setDraft("new:home", "What changed in 1848?");
  claimLocalAccountState("u1");
  t.is(useDraftsStore.getState().get("new:home")?.text, "What changed in 1848?");
  claimDrafts("u2");
  t.is(useDraftsStore.getState().get("new:home"), undefined);
});

test.serial("without a session drafts are unreadable until the account returns", (t) => {
  claimLocalAccountState("u1");
  useDraftsStore.getState().setDraft("new:home", "kept");
  claimLocalAccountState(null);
  t.is(useDraftsStore.getState().get("new:home"), undefined);
  useDraftsStore.getState().setDraft("new:home", "ignored");
  claimLocalAccountState("u1");
  t.is(useDraftsStore.getState().get("new:home")?.text, "kept");
});

test.serial("sign-out clears them", (t) => {
  claimLocalAccountState("u1");
  useDraftsStore.getState().setDraft("new:home", "gone");
  clearLocalAccountState();
  t.deepEqual(useDraftsStore.getState().byKey, {});
  t.is(useDraftsStore.getState().owner, null);
});
