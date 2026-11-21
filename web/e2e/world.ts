// The records a spec reads, written through the sync routes of the suite's
// server (`01` §6, M3) as the people who would write them: each person is a
// signed-in browser context of its own that registers a client id and sends
// envelopes to `POST /api/sync/apply`. Channel names carry the run's id, as
// logins do (`helpers.ts` `e2eLogin`), so neither a retry nor another spec
// meets them.

import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";

import { APP_ORIGIN, E2E_RUN_ID_VARIABLE } from "./constants.js";
import { PROTOCOL_HEADERS, signIn, type SignedInUser } from "./helpers.js";

const SYNC_HEADERS = {
  "x-requested-with": "session",
  "content-type": "application/json",
  ...PROTOCOL_HEADERS,
};

/** `PROTOCOL_VERSION` of `@session/sync`. */
const PROTOCOL_VERSION = Number(PROTOCOL_HEADERS["session-protocol"]);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID at `at` (ms). */
export function ulid(at = Date.now()): string {
  let time = "";
  let t = at;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let random = "";
  for (let i = 0; i < 16; i++) random += CROCKFORD.charAt(Math.floor(Math.random() * 32));
  return time + random;
}

/** Three letters of this worker process: a worker that restarts after a
 * failure runs `beforeAll` again, and makes its channels again. */
const WORKER = Math.random().toString(36).slice(2, 5).padEnd(3, "0");

/** The tag of channel names: the run id, the worker's letters and, on a
 * retry, its number. */
export function runTag(): string {
  const run = process.env[E2E_RUN_ID_VARIABLE] ?? "local";
  let retry = 0;
  try {
    retry = test.info().retry;
  } catch {
    // outside a test
  }
  return `${run.toLowerCase()}${WORKER}${retry > 0 ? `r${retry}` : ""}`;
}

/** A channel name of this run: `base` (at most 15 characters) and the tag. */
export const channelName = (base: string) => `${base}-${runTag()}`;

interface Answer {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; expectedSeq?: number };
}

/** A person writing through the sync routes from their own context. */
export class Writer {
  clientId = "";
  seq = 0;

  constructor(
    readonly request: APIRequestContext,
    readonly user: SignedInUser & { handle: string },
  ) {}

  get handle(): string {
    return this.user.handle;
  }

  private async register(): Promise<void> {
    const res = await this.request.post(`${APP_ORIGIN}/api/sync/register`, {
      headers: SYNC_HEADERS,
      data: {},
    });
    const body = (await res.json()) as { ok: boolean; clientId: string; lastSeq: number };
    expect(body.ok, `register: ${JSON.stringify(body)}`).toBe(true);
    this.clientId = body.clientId;
    this.seq = body.lastSeq;
  }

  /** Sends writes in order in one request; answers them in order. */
  async send(writes: readonly (readonly [string, unknown])[]): Promise<Answer[]> {
    if (!this.clientId) await this.register();
    const now = Date.now();
    const first = this.seq + 1;
    const envelopes = writes.map(([name, input], i) => ({
      clientId: this.clientId,
      seq: first + i,
      mutationId: ulid(now),
      name,
      input,
      protocolVersion: PROTOCOL_VERSION,
      clientTime: now,
      queuedAt: now,
    }));
    const res = await this.request.post(`${APP_ORIGIN}/api/sync/apply`, {
      headers: SYNC_HEADERS,
      data: { envelopes },
    });
    const { answers } = (await res.json()) as { answers: Answer[] };
    this.seq = first + writes.length - 1;
    return answers;
  }

  /** One write that must be applied; its result. */
  async ok(name: string, input: unknown): Promise<unknown> {
    const [answer] = await this.send([[name, input]]);
    expect(answer?.ok, `${name}: ${JSON.stringify(answer?.error)}`).toBe(true);
    return answer?.result;
  }

  /** Writes that must all be applied, in batches of 100. */
  async all(writes: readonly (readonly [string, unknown])[]): Promise<void> {
    for (let i = 0; i < writes.length; i += 100) {
      const answers = await this.send(writes.slice(i, i + 100));
      for (const a of answers) expect(a.ok, JSON.stringify(a.error)).toBe(true);
    }
  }

  // ---- the writes the specs make ----

  async channel(name: string, o: { vis?: "open" | "private"; desc?: string } = {}) {
    const id = ulid();
    await this.ok("spaces.create", {
      id,
      name,
      ...(o.vis ? { vis: o.vis } : {}),
      ...(o.desc ? { desc: o.desc } : {}),
    });
    return id;
  }

  join(space: string, invite?: string) {
    return this.ok("spaces.join", { space, ...(invite ? { invite } : {}) });
  }

  /** An invite link to a private channel this person owns; its code. */
  async invite(space: string): Promise<string> {
    const r = (await this.ok("invites.create", { id: ulid(), space, days: 7 })) as { code: string };
    return r.code;
  }

  async post(space: string, q: string): Promise<string> {
    const id = ulid();
    await this.ok("threads.create", { id, space, kind: "post", q });
    return id;
  }

  async reply(thread: string, t: string, parent?: string): Promise<string> {
    const id = ulid();
    await this.ok("research.createPostFollowUp", {
      id,
      thread,
      t,
      ...(parent ? { parent } : {}),
    });
    return id;
  }

  save(thread: string) {
    return this.ok("saved.set", { kind: "thread", id: thread, on: true });
  }

  /** The owner removes a post with a reason. */
  remove(post: string, note: string) {
    return this.ok("moderation.decide", { item: `p:${post}`, decision: "removed", note });
  }
}

/** A person of the spec's world: a context of their own, signed in as the
 * run's account for `login`. */
export async function person(browser: Browser, login: string): Promise<Writer> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const user = await signIn(page, { login });
  const handle = (user as SignedInUser & { handle?: string | null }).handle;
  if (!handle) throw new Error(`${login} has no handle`);
  return new Writer(context.request, { ...user, handle });
}
