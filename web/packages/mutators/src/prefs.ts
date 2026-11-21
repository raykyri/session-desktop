// A person's preferences (`01` C13): the layout toggle, in their user log.

import { prefsKey } from "./records.js";
import { M } from "./rules.js";
import { define } from "./tx.js";

export const PREFS = {
  "prefs.set": define({
    input: M["prefs.set"].input,
    who: "user",
    intent: "none",
    run: (tx, i) => {
      const old = tx.byKey(prefsKey(tx.me));
      if (old?.kind !== "prefs" || old.layout !== i.layout)
        tx.put({ kind: "prefs", u: tx.me, layout: i.layout });
      return null;
    },
  }),
};
