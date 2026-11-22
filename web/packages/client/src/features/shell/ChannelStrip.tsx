// The channel strip (02 §2.2 item 3; `headerSpaces`): horizontally scrolling
// `#name` chips, the current one marked `aria-current="page"`; a join "+" on
// unjoined chips under All; a trailing New channel button for writers; and
// the scope's empty line. No scrollbar: the edges fade 40 px only while chips
// are hidden past them, and the current chip is scrolled to the centre when
// it lies within 40 px of an edge.

import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";

import { prefersReducedMotion } from "../../lib/motion.js";
import type { ChannelScope } from "../../stores/navigation.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { PlusIcon } from "./icons.js";
import type { ShellChannel } from "./shellData.js";

/** Width of the edge fade, and the margin that triggers centring. */
export const STRIP_EDGE = 40;

/** The fade on each edge for a strip scrolled to `scrollLeft` (`--fl`,
 * `--fr`): 40px while content is hidden past that edge, else 0px. */
export function stripFades(el: { scrollLeft: number; clientWidth: number; scrollWidth: number }): {
  left: string;
  right: string;
} {
  const hiddenLeft = el.scrollLeft > 1;
  const hiddenRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  return {
    left: hiddenLeft ? `${STRIP_EDGE}px` : "0px",
    right: hiddenRight ? `${STRIP_EDGE}px` : "0px",
  };
}

/** The strip's `scrollLeft` that centres a chip at `chip.left` (measured
 * from the start of the strip's content) when the chip lies within
 * `STRIP_EDGE` of either edge; null when it needs no scroll. */
export function centredScrollLeft(
  el: { scrollLeft: number; clientWidth: number },
  chip: { left: number; width: number },
): number | null {
  const nearRight = chip.left + chip.width > el.scrollLeft + el.clientWidth - STRIP_EDGE;
  const nearLeft = chip.left < el.scrollLeft + STRIP_EDGE;
  if (!nearRight && !nearLeft) return null;
  return chip.left - el.clientWidth / 2 + chip.width / 2;
}

export function emptyStripLine(scope: ChannelScope): string {
  return scope === "yours" ? "You have not made a channel yet." : "Nothing here yet.";
}

export interface ChannelStripProps {
  channels: readonly ShellChannel[];
  scope: ChannelScope;
  /** The channel whose feed is open, without `#`. */
  current: string | null;
  /** True for accounts that can write: join buttons and New channel. */
  canWrite: boolean;
  onJoin?: ((channel: ShellChannel) => void) | undefined;
  onNewChannel?: (() => void) | undefined;
}

const CHIP =
  "inline-flex h-[26px] shrink-0 items-center rounded-[14px] px-2.5 text-sm font-medium whitespace-nowrap " +
  "text-fg-secondary hover:bg-surface-fill-hover " +
  "aria-[current=page]:bg-fg-heading aria-[current=page]:text-surface-feed " +
  FOCUS_RING;

export function ChannelStrip({
  channels,
  scope,
  current,
  canWrite,
  onJoin,
  onNewChannel,
}: ChannelStripProps) {
  const strip = useRef<HTMLDivElement | null>(null);

  // Fades follow the scroll position and the strip's size.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const fade = () => {
      const { left, right } = stripFades(el);
      el.style.setProperty("--fl", left);
      el.style.setProperty("--fr", right);
    };
    fade();
    el.addEventListener("scroll", fade, { passive: true });
    const observer = new ResizeObserver(fade);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", fade);
      observer.disconnect();
    };
  }, [channels]);

  // The current chip is brought to the centre when it is near an edge. Its
  // place is measured from the strip's scrolled content: `offsetLeft` would
  // count from the chip's offset parent, the bar, and so include the brand
  // and the scope picker.
  useLayoutEffect(() => {
    const el = strip.current;
    const chip = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !chip) return;
    const left = chip.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    const target = centredScrollLeft(
      { scrollLeft: el.scrollLeft, clientWidth: el.clientWidth },
      { left, width: chip.offsetWidth },
    );
    if (target === null) return;
    el.scrollTo({ left: target, behavior: prefersReducedMotion() ? "instant" : "smooth" });
  }, [current, channels]);

  return (
    <nav aria-label="Channels" className="flex min-w-0 flex-1">
      <div
        ref={strip}
        className="channel-strip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {channels.map((channel) => {
          // as Browse and the channel header: no Join on a frozen channel
          const joinable = scope === "all" && canWrite && !channel.joined && !channel.frozen;
          return (
            <span key={channel.id} className="inline-flex shrink-0 items-center">
              <Link
                to="/c/$name"
                params={{ name: channel.name }}
                search={{}}
                aria-current={current === channel.name ? "page" : undefined}
                className={CHIP}
              >
                #{channel.name}
              </Link>
              {joinable ? (
                <button
                  type="button"
                  title="Join"
                  aria-label={`Join #${channel.name}`}
                  onClick={() => onJoin?.(channel)}
                  className={
                    "bg-accent-soft text-accent mr-1 -ml-1.5 inline-grid size-4 place-items-center rounded-lg text-xs leading-none font-bold " +
                    FOCUS_RING
                  }
                >
                  +
                </button>
              ) : null}
            </span>
          );
        })}
        {channels.length === 0 ? (
          <span className="text-fg-faint px-2 text-sm whitespace-nowrap">
            {emptyStripLine(scope)}
          </span>
        ) : null}
        {canWrite ? (
          <button
            type="button"
            title="New channel"
            aria-label="New channel"
            onClick={() => onNewChannel?.()}
            className={
              "text-fg-muted hover:bg-surface-fill-hover hover:text-fg-heading inline-grid size-7 shrink-0 place-items-center rounded-[14px] " +
              FOCUS_RING
            }
          >
            <PlusIcon />
          </button>
        ) : null}
      </div>
    </nav>
  );
}
