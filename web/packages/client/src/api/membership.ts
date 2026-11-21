// Account invites, the profile step, the invite tree and the sign-in start
// (02 W7.1-W7.3; plan 04 I2-I4). Online-only tRPC, read through TanStack
// Query; nothing here is replicated.

import type { InviteCheck, SignInProvider } from "@session/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "./account.js";
import { REQUESTED_WITH_HEADERS, trpc } from "./trpc.js";

export const membershipKeys = {
  invites: () => ["accountInvites"] as const,
  tree: () => ["membersTree"] as const,
};

export function checkInvite(code: string): Promise<InviteCheck> {
  return trpc().auth.checkInvite.mutate({ code });
}

export function redeemInvite(code: string): Promise<InviteCheck> {
  return trpc().accountInvites.redeem.mutate({ code });
}

export function checkHandle(handle: string) {
  return trpc().account.checkHandle.query({ handle });
}

export function createAccount(input: { name: string; handle: string }) {
  return trpc().account.create.mutate(input);
}

/**
 * Starts a sign-in (04 I4): `POST /auth/<provider>/start` with the invite
 * code in the body, never in a URL, then the whole page goes to the
 * provider. Resolves only if the server refuses.
 */
export async function startSignIn(
  provider: SignInProvider,
  input: { code?: string | null; returnTo?: string | null } = {},
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const response = await fetch(`/auth/${provider}/start`, {
    method: "POST",
    credentials: "include",
    headers: { ...REQUESTED_WITH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(input.code ? { code: input.code } : {}),
      ...(input.returnTo ? { returnTo: input.returnTo } : {}),
    }),
  });
  const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (!response.ok || typeof body?.url !== "string") {
    throw new Error(
      response.status === 429
        ? "Too many sign-in attempts. Try again in a minute."
        : "Sign-in is not available right now. Try again later.",
    );
  }
  navigate(body.url);
}

export function useAccountInvites() {
  return useQuery({
    queryKey: membershipKeys.invites(),
    queryFn: () => trpc().accountInvites.list.query(),
  });
}

export function useMembersTree() {
  return useQuery({ queryKey: membershipKeys.tree(), queryFn: () => trpc().members.tree.query() });
}

export function useCreateInviteLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => trpc().accountInvites.create.mutate(),
    onSuccess: () => client.invalidateQueries({ queryKey: membershipKeys.invites() }),
  });
}

export function useRevokeInviteLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => trpc().accountInvites.revoke.mutate({ id }),
    onSuccess: () => client.invalidateQueries({ queryKey: membershipKeys.invites() }),
  });
}

/** After the profile step the account is active: `auth.me` and everything
 * read for the waiting account is stale. */
export function useCreateAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createAccount,
    onSuccess: async (result) => {
      client.setQueryData(queryKeys.me(), result.me);
      await client.invalidateQueries();
    },
  });
}
