// Security headers on every response (`03-api-and-events.md` §5,
// `07-client-architecture.md` §9).

import type { MiddlewareHandler } from "hono";

import type { Config } from "../config.js";
import type { AppEnv } from "../deps.js";

/** Hosts the Markdown renderer is allowed to load tweet media and avatars
 * from; every other remote image stays blocked (`07` §9). */
const IMAGE_HOSTS = [
  "https://pbs.twimg.com",
  "https://abs.twimg.com",
  "https://avatars.githubusercontent.com",
];

/**
 * The app's CSP. `style-src` carries `unsafe-inline` because MathJax and
 * mermaid inject style elements; there is no `unsafe-eval`, which is why the
 * client keeps the `PACKAGE_VERSION` define instead of letting MathJax
 * compile at runtime.
 */
export function contentSecurityPolicy(artifactOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${IMAGE_HOSTS.join(" ")}`,
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${artifactOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self' https://github.com",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(config: Config): MiddlewareHandler<AppEnv> {
  const policy = contentSecurityPolicy(config.artifactOrigin);
  return async (c, next) => {
    await next();
    // The artifact origin sets its own, far stricter policy per response
    // (`11-artifacts-and-browser.md` §2); do not overwrite it.
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.res.headers.set("Content-Security-Policy", policy);
    }
    c.res.headers.set("Referrer-Policy", "no-referrer");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    // The preview panel frames the artifact origin, so that host must stay
    // framable; its own response allows exactly one ancestor through
    // `frame-ancestors`. The app itself is framed by nothing.
    if (c.req.header("host") !== config.artifactHost) {
      c.res.headers.set("X-Frame-Options", "DENY");
    }
    c.res.headers.set(
      "Permissions-Policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    );
    if (config.isProduction) {
      c.res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  };
}
