// Operator commands on accounts (plan `04` I1, §8; `05` §3.5). There is no
// in-app promotion and no in-app deletion, so these run against the volume
// (`fly ssh console`).
//
//   npm run db:admin -- <handle> [--revoke]    make the account with this
//                                              handle a site admin, or stop
//   npm run db:admin -- --invite               print one root account invite
//   npm run db:admin -- --delete <handle>      the account-deletion job, with
//                                              the server stopped: it refuses
//                                              while a server's heartbeat is
//                                              fresh or another process has
//                                              the database open
//                                              (`web/docs/runbooks/delete-account.md`)
//   npm run db:admin -- --new-history          replace the sync history id at
//                                              the next boot, after a restore
//                                              that kept the file's identity
//                                              (`runbooks/restore.md`)
//   npm run db:admin -- --grant-invites <handle> <n>
//                                              give the member n (1 to 100)
//                                              more account invites, as Site
//                                              Admin's Invites section does;
//                                              reads SESSION_INVITES_PER_MEMBER
//                                              for the total it prints
//
// Root invites have no creator: each person who runs Session redeems one,
// chooses a handle at the profile step, and is then promoted by handle.
//
// The runtime image has no sources and no tsx; it holds this file bundled as
// `packages/server/dist/admin.mjs`, run with the same arguments:
//
//   node /app/packages/server/dist/admin.mjs --invite
//
// The file has no `#!` line: esbuild copies an entry's `#!` line into the
// bundle, where a `tsx` one names a program the image does not have.
// `npm run db:admin` runs it with tsx.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INVITE_GRANT_MAX,
  accountInviteLink,
  inviteAllowanceLine,
  inviteGrantToast,
} from "@session/shared";

import {
  accountInvites,
  accounts,
  closeDatabase,
  openDatabase,
  requestNewHistory,
  users,
  type SessionDatabase,
} from "../src/index.js";

const USAGE =
  "usage: npm run db:admin -- <handle> [--revoke]\n" +
  "       npm run db:admin -- --invite\n" +
  "       npm run db:admin -- --delete <handle>\n" +
  "       npm run db:admin -- --new-history\n" +
  "       npm run db:admin -- --grant-invites <handle> <n>\n";

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith("--")));
const positional = args.filter((argument) => !argument.startsWith("--"));
const handle = positional[0]?.replace(/^@/, "");

if (!flags.has("--invite") && !flags.has("--new-history") && handle === undefined) {
  process.stderr.write(USAGE);
  process.exit(1);
}

/** A whole number written in decimal digits, or null. */
const wholeNumber = (text: string | undefined): number | null =>
  text !== undefined && /^\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : null;

// `--grant-invites`: the count, and the deployment's invites per member for
// the total it prints (the server's setting, read the same way).
let grantCount = 0;
let perMember = accountInvites.DEFAULT_INVITES_PER_MEMBER;
if (flags.has("--grant-invites")) {
  const count = wholeNumber(positional[1]);
  if (count === null || count < 1 || count > INVITE_GRANT_MAX) {
    process.stderr.write(
      `The number of invites is a whole number from 1 to ${INVITE_GRANT_MAX}.\n`,
    );
    process.stderr.write(USAGE);
    process.exit(1);
  }
  grantCount = count;
  const setting = process.env["SESSION_INVITES_PER_MEMBER"];
  if (setting !== undefined && setting.trim() !== "") {
    const value = wholeNumber(setting);
    if (value === null || value < 1) {
      process.stderr.write("SESSION_INVITES_PER_MEMBER must be a whole number of at least 1.\n");
      process.exit(1);
    }
    perMember = value;
  }
}

const dataDir = process.env["SESSION_DATA_DIR"];
const path = dataDir ? resolve(dataDir, "session.db") : resolve(".data/session.db");
// `../../db/migrations` from this file names `packages/db/migrations` both
// here (`packages/db/bin/admin.ts`, run with tsx) and from the bundle the
// image holds (`packages/server/dist/admin.mjs`), as `main.ts` resolves it.
const migrationsFolder = fileURLToPath(new URL("../../db/migrations", import.meta.url));
let db: SessionDatabase;
try {
  db = openDatabase(path, { migrationsFolder });
} catch (error) {
  // a database of a newer build, or of a build from before the M8a squash:
  // its message names the runbook (`UnknownMigrationError`)
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
try {
  if (flags.has("--new-history")) {
    requestNewHistory(db.$client);
    process.stdout.write(
      "the next boot replaces the sync history id: every cursor served before it resyncs\n",
    );
  } else if (flags.has("--invite")) {
    const { code } = accountInvites.createRoot(db);
    const origin = process.env["SESSION_PUBLIC_ORIGIN"];
    process.stdout.write(
      origin ? `${code}\n${accountInviteLink(origin.replace(/\/$/, ""), code)}\n` : `${code}\n`,
    );
  } else if (flags.has("--grant-invites")) {
    const account = users.findActiveByHandle(db, handle ?? "");
    if (account === null) {
      throw new Error(`No active account has the handle @${handle ?? ""}.`);
    }
    const after = accountInvites.grant(db, account.id, grantCount, perMember);
    const name = account.handle ?? "";
    process.stdout.write(
      `${inviteGrantToast(name, grantCount)} ${inviteAllowanceLine({ handle: name, ...after })}\n`,
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
          ? `${spaces.items} item(s) deleted, ${spaces.rewritten} record(s) no longer naming them, ` +
            `${spaces.records} record(s) removed, ` +
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
