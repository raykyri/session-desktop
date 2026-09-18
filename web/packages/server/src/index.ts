import { serve } from "@hono/node-server";

import { app } from "./app.js";

const hostname = process.env["HOST"] ?? "127.0.0.1";
const port = Number(process.env["PORT"] ?? 8787);

serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`session-server listening on http://${hostname}:${info.port}`);
});
