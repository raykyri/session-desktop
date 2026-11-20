// Whether widget scripts may run on this deployment
// (`11-artifacts-and-browser.md` §2).
//
// A widget's run page executes HTML an agent wrote. It is served from the
// artifact origin, inside an iframe sandboxed without `allow-same-origin`, so
// its document has an opaque origin. The deployment adds one more condition:
// the artifact origin must be a different *site* (registrable domain) from
// the app. A subdomain of the app (`artifacts.session.dev` beside
// `session.dev`) is the same site: browsers treat requests between the two as
// same-site for `SameSite` cookies and `Sec-Fetch-Site`, and the parent
// domain's cookie scope covers both. When the two origins share a site the
// server serves only the static page, whatever the rest of the configuration.

import { isIP } from "node:net";

import { getDomain } from "tldts";

export interface WidgetScriptPolicy {
  /** True when the run page (`allow-scripts`, inline scripts) is served. */
  allowed: boolean;
  /** Why scripts are off, for the boot log; null when they are allowed. */
  reason: string | null;
}

/**
 * The site of a host, as browsers compute it for `SameSite`: the registrable
 * domain under the Public Suffix List with its private section (so
 * `a.fly.dev` and `b.fly.dev` are different sites), or the host itself for an
 * IP address or a host with no registrable domain (`localhost`).
 */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isIP(host) !== 0) {
    return host;
  }
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/** Scripts run only when the artifact origin and the app are different
 * sites. The scheme is ignored, which can only turn scripts off. */
export function widgetScriptPolicy(
  publicOrigin: string,
  artifactOrigin: string,
): WidgetScriptPolicy {
  const appSite = siteOf(new URL(publicOrigin).hostname);
  const artifactSite = siteOf(new URL(artifactOrigin).hostname);
  if (appSite !== artifactSite) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason:
      `SESSION_ARTIFACT_ORIGIN (${artifactOrigin}) is on the same site (${artifactSite}) as ` +
      `SESSION_PUBLIC_ORIGIN (${publicOrigin}). Widget scripts are off and widgets show their ` +
      `static page only. To run widget scripts, set SESSION_ARTIFACT_ORIGIN to a host on ` +
      `another registrable domain, not a subdomain of the app's domain (web/SETUP.md).`,
  };
}
