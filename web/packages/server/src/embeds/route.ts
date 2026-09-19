// `GET /embeds/:hash` (`03-api-and-events.md` §5).
//
// The image half of an embedded post. A hydrated snapshot points here instead
// of at `pbs.twimg.com` (`storage.ts`), so the card's pictures come from this
// origin: one `img-src` for the page, no request to X from the reader's
// browser, and a picture that survives the post it belongs to.
//
// Public, like the cards themselves — the Home feed is readable signed out —
// and it can only ever serve a URL some snapshot was hydrated from, because
// the hash is the key of a row this server wrote and the row's URL is checked
// against the host allowlist on the way out as well as on the way in.

import { Hono } from "hono";
import type { Context } from "hono";

import type { AppEnv, ServerDeps } from "../deps.js";

import { EmbedStore } from "./storage.js";

/** Hex SHA-256, the only shape `embed_assets.hash` takes. */
const HASH = /^[0-9a-f]{64}$/;

export interface EmbedRoutesOptions {
  deps: ServerDeps;
  store?: EmbedStore;
}

export function embedRoutes(options: EmbedRoutesOptions): Hono<AppEnv> {
  const { deps } = options;
  const store =
    options.store ??
    new EmbedStore({
      db: deps.db,
      embedsDir: deps.config.embedsDir,
      fetch: deps.fetch ?? globalThis.fetch,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
  const app = new Hono<AppEnv>();

  /** An unregistered hash and an origin that will not answer are the same
   * answer: there is no image to serve, and the card renders its fallback
   * rather than a broken box. Held briefly so a card whose image X has stopped
   * serving does not ask again on every render. */
  const missing = (c: Context<AppEnv>): Response =>
    c.text("Not found", 404, { "Cache-Control": "public, max-age=300" });

  app.get("/embeds/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!HASH.test(hash)) {
      return missing(c);
    }
    const asset = await store.read(hash);
    if (!asset) {
      return missing(c);
    }
    return new Response(asset.bytes, {
      status: 200,
      headers: {
        "Content-Type": asset.contentType,
        // The hash is taken over the source URL, and a twimg URL addresses one
        // immutable image, so a response may be cached for as long as the
        // browser likes.
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(asset.bytes.byteLength),
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  });

  return app;
}
