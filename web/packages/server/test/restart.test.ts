// The server process killed around a commit (`01` S5, D2, U1; M3 exit
// criteria). The server runs as a child process over a temp database and
// kills itself with SIGKILL, a test fault of a test server (`main.ts`
// `testFaults`):
//
// - after the commit of a write, before its response: after a restart the
//   replayed envelope is answered from the stored answer, and the write was
//   applied once;
// - inside the commit, after the mutator's stages ran: after a restart there
//   is neither the write nor its notifications, and the resent envelope
//   applies, notifications included.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { auth, closeDatabase, openDatabase, users } from "@session/db";
import { PROTOCOL_VERSION, ulid, type ApplyResult, type Envelope } from "@session/sync/server";
import test, { type ExecutionContext } from "ava";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "http://localhost:8787";
const id = () => ulid(Date.now(), Math.random);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

class Server {
  child: ChildProcess | null = null;
  port = 0;

  constructor(readonly dir: string) {}

  async start(env: Record<string, string> = {}): Promise<void> {
    this.port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: PACKAGE,
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(this.port),
        SESSION_PUBLIC_ORIGIN: ORIGIN,
        SESSION_DATA_DIR: this.dir,
        TSX_TSCONFIG_PATH: "tsconfig.test.json",
        ...env,
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    this.child = child;
    for (let k = 0; k < 200; k++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/healthz`);
        if (r.ok) return;
      } catch {
        // not listening yet
      }
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the server did not start");
  }

  /** Resolves with the signal that ended the process. */
  async exited(): Promise<NodeJS.Signals | null> {
    const child = this.child;
    if (!child) return null;
    if (child.exitCode !== null || child.signalCode !== null) return child.signalCode;
    return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
  }

  async stop(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      await this.exited();
    }
    this.child = null;
  }

  async post(path: string, cookie: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "X-Requested-With": "session",
        "Session-Protocol": String(PROTOCOL_VERSION),
        "Content-Type": "application/json",
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify(body),
    });
  }
}

interface Setup {
  server: Server;
  dir: string;
  cookies: Record<string, string>;
  clients: Record<string, string>;
  seqs: Record<string, number>;
  post: string;
}

/** Accounts made in the database first; a channel and a post over HTTP. */
async function setup(t: ExecutionContext): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), "session-restart-"));
  const server = new Server(dir);
  t.teardown(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const db = openDatabase(join(dir, "session.db"));
  const cookies: Record<string, string> = {};
  for (const [k, login] of ["mona", "mel", "otto"].entries()) {
    const u = users.createActive(
      db,
      { provider: "github", providerUserId: String(9000 + k), login, name: login },
      { handle: login },
    );
    cookies[login] = auth.createSession(db, u.id).token;
  }
  closeDatabase(db);
  await server.start();
  const clients: Record<string, string> = {};
  const seqs: Record<string, number> = {};
  for (const u of Object.keys(cookies)) {
    const r = (await (await server.post("/api/sync/register", cookies[u] ?? "", {})).json()) as {
      clientId: string;
    };
    clients[u] = r.clientId;
    seqs[u] = 0;
  }
  const s: Setup = { server, dir, cookies, clients, seqs, post: "" };
  const space = id();
  await apply(s, "mona", envelope(s, "mona", "spaces.create", { id: space, name: "lounge" }));
  for (const u of ["mel", "otto"]) await apply(s, u, envelope(s, u, "spaces.join", { space }));
  s.post = id();
  await apply(
    s,
    "mona",
    envelope(s, "mona", "threads.create", { id: s.post, space, kind: "post", q: "A post" }),
  );
  return s;
}

function envelope(s: Setup, u: string, name: string, input: unknown): Envelope {
  const now = Date.now();
  s.seqs[u] = (s.seqs[u] ?? 0) + 1;
  return {
    clientId: s.clients[u] ?? "",
    seq: s.seqs[u],
    mutationId: id(),
    name,
    input,
    protocolVersion: PROTOCOL_VERSION,
    clientTime: now,
    queuedAt: now,
  };
}

async function apply(s: Setup, u: string, e: Envelope): Promise<ApplyResult> {
  const res = await s.server.post("/api/sync/apply", s.cookies[u] ?? "", { envelopes: [e] });
  const a = ((await res.json()) as { answers: ApplyResult[] }).answers[0];
  if (!a) throw new Error("no answer");
  return a;
}

/** The records of `kind` in the database file, read with the server down. */
function stored(s: Setup, kind: string): { key: string; body: Record<string, unknown> }[] {
  const db = openDatabase(join(s.dir, "session.db"));
  try {
    return (
      db.$client.prepare("SELECT key, body FROM records WHERE kind = ? ORDER BY key").all(kind) as {
        key: string;
        body: string;
      }[]
    ).map((r) => ({ key: r.key, body: JSON.parse(r.body) as Record<string, unknown> }));
  } finally {
    closeDatabase(db);
  }
}

test("a server killed between the commit and the response answers the replayed envelope from the stored answer", async (t) => {
  const s = await setup(t);
  await s.server.stop();
  await s.server.start({ SESSION_TEST_KILL_AFTER_COMMIT: "research.createPostFollowUp" });
  const reply = id();
  const e = envelope(s, "mel", "research.createPostFollowUp", {
    id: reply,
    thread: s.post,
    t: "Agreed, @otto",
  });
  await t.throwsAsync(apply(s, "mel", e));
  t.is(await s.server.exited(), "SIGKILL");
  // committed: the reply and its notifications are in the file
  t.deepEqual(
    stored(s, "reply").map((r) => r.key),
    [`reply:${reply}`],
  );
  t.is(stored(s, "notif").length, 2);
  await s.server.start();
  const again = await apply(s, "mel", e);
  t.like(again, { ok: true, result: { notified: ["otto"], notMembers: [] } });
  // the stored answer: nothing applied twice
  t.is(stored(s, "reply")[0]?.body["rev"], 1);
  t.is(stored(s, "notif").length, 2);
  // and the client's next seq follows it
  const next = await apply(s, "mel", envelope(s, "mel", "prefs.set", { layout: "wide" }));
  t.true(next.ok);
});

test("a server killed inside the commit leaves no write and no notification; the resent envelope applies with them", async (t) => {
  const s = await setup(t);
  await s.server.stop();
  await s.server.start({ SESSION_TEST_KILL_BEFORE_COMMIT: "research.createPostFollowUp" });
  const reply = id();
  const e = envelope(s, "mel", "research.createPostFollowUp", {
    id: reply,
    thread: s.post,
    t: "Agreed, @otto",
  });
  await t.throwsAsync(apply(s, "mel", e));
  t.is(await s.server.exited(), "SIGKILL");
  t.deepEqual(stored(s, "reply"), []);
  t.deepEqual(stored(s, "notif"), []);
  await s.server.start();
  const again = await apply(s, "mel", e);
  t.like(again, { ok: true, result: { notified: ["otto"], notMembers: [] } });
  t.deepEqual(
    stored(s, "reply").map((r) => r.key),
    [`reply:${reply}`],
  );
  t.deepEqual(
    stored(s, "notif")
      .map((n) => `${String(n.body["to"])}:${String(n.body["type"])}`)
      .sort(),
    ["mona:reply", "otto:mention"],
  );
});
