// The site footer (02 W2.7, `siteFoot`): ends every feed and page, signed in
// or out. The address is the abuse mailbox of the configured public origin.

import { abuseAddress } from "../../lib/publicOrigin.js";

export function SiteFooter({ origin }: { origin?: string }) {
  const address = abuseAddress(origin);
  return (
    <footer className="border-border-divider text-fg-faint mt-10 border-t pt-3.5 text-center text-xs">
      Session · Report abuse:{" "}
      <a href={`mailto:${address}`} className="text-fg-muted hover:text-fg-heading">
        {address}
      </a>
    </footer>
  );
}
