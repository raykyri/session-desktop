// `/unsent`: Unsent changes as a page (the Desktop app; the mockup's
// `sxOutboxRaw`), opened from the badge's popover and a toast's Details.

import { UnsentList } from "./Outbox.js";
import { Page } from "./Page.js";
import { BackRow } from "./nav.js";

/** `/unsent`: the list as a page (the badge's Open Unsent changes, and a
 * toast's Details). */
export function UnsentPage() {
  return (
    <Page place={{ kind: "other", label: "Unsent changes" }}>
      <div className="home-wide sub-page sx-obp">
        <BackRow />
        <div className="sub-top">
          <h2>Unsent changes</h2>
        </div>
        <UnsentList />
      </div>
    </Page>
  );
}
