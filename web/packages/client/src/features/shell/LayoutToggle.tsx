// The layout toggle (02 §2.2 item 6; `layoutBtn`): switches the feed between
// `centred` and `wide` (§3.1). Its icon shows the target layout: arrows
// outward ("Expand") in `centred`, inward ("Collapse") in `wide`.

import { cn } from "../../lib/cn.js";
import type { FeedLayout } from "../../stores/navigation.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { CollapseIcon, ExpandIcon } from "./icons.js";
import { ROUND_BUTTON } from "./menuStyles.js";

export function layoutToggleLabel(layout: FeedLayout): "Expand" | "Collapse" {
  return layout === "centred" ? "Expand" : "Collapse";
}

export function LayoutToggle({ layout, onToggle }: { layout: FeedLayout; onToggle: () => void }) {
  const label = layoutToggleLabel(layout);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={cn(ROUND_BUTTON, "hover:text-fg-heading w-[30px] p-0", FOCUS_RING)}
    >
      {layout === "centred" ? <ExpandIcon size={15} /> : <CollapseIcon size={15} />}
    </button>
  );
}
