#!/usr/bin/env tsx
// Operator commands on accounts (plan `04` I1, §8; `05` §3.5). There is no
// in-app promotion and no in-app deletion, so these run against the volume
// (`fly ssh console`).
//
//   npm run db:admin -- <handle> [--revoke]    make the account with this
//                                              handle a site admin, or stop
//   npm run db:admin -- --invite               print one root account invite
//   npm run db:admin -- --delete <handle>      the account-deletion job, with
//                                              the server stopped
//                                              (`web/docs/runbooks/delete-account.md`)
//
// Root invites have no creator: each person who runs Session redeems one,
// chooses a handle at the profile step, and is then promoted by handle.

import { resolve } from "node:path";

import { accountInviteLink } from "@session/shared";

import { accountInvites, accounts, closeDatabase, openDatabase, users } from "../src/index.js";

const USAGE =
  "usage: npm run db:admin -- <handle> [--revoke]\n" +
  "       npm run db:admin -- --invite\n" +
  "       npm run db:admin -- --delete <handle>\n";

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith("--")));
const handle = args.find((argument) => !argument.startsWith("--"))?.replace(/^@/, "");

if (!flags.has("--invite") && handle === undefined) {
  process.stderr.write(USAGE);
  process.exit(1);
}

const dataDir = process.env["SESSION_DATA_DIR"];
const path = dataDir ? resolve(dataDir, "session.db") : resolve(".data/session.db");
const db = openDatabase(path);
try {
  if (flags.has("--invite")) {
    const { code } = accountInvites.createRoot(db);
    const origin = process.env["SESSION_PUBLIC_ORIGIN"];
    process.stdout.write(
      origin ? `${code}\n${accountInviteLink(origin.replace(/\/$/, ""), code)}\n` : `${code}\n`,
    );
  } else if (flags.has("--delete")) {
    const account = users.findByHandle(db, handle ?? "");
    if (account === null || account.provider === null) {
      throw new Error(`No account has the handle @${handle ?? ""}.`);
    }
    const deleted = accounts.deleteAccount(db, account.id);
    const spaces = deleted.spaces;
    process.stdout.write(
      `deleted the sign-in identity of @${deleted.handle ?? ""}; ` +
        `${deleted.sessions} session(s) ended, ${deleted.revokedInvites} open invite(s) revoked; ` +
        (spaces
          ? `${spaces.items} item(s) deleted, ${spaces.records} record(s) removed, ` +
            `frozen: ${spaces.frozen.length ? spaces.frozen.map((n) => `#${n}`).join(", ") : "none"}; `
          : "") +
        "the handle stays reserved\n",
    );
  } else {
    const user = users.setAdminByHandle(db, handle ?? "", !flags.has("--revoke"));
    process.stdout.write(
      `@${user.handle ?? ""} is ${user.isAdmin ? "now a site admin" : "no longer a site admin"}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  closeDatabase(db);
}
