// Width bounds of the resizable left sidebar.
import { clamp } from "./appHelpers";

export const SIDEBAR_MIN_WIDTH = 208;
const SIDEBAR_MAX_WIDTH = 420;
/** The icon rail's width. */
export const SIDEBAR_RAIL_WIDTH = 52;
// The width the research stage keeps when the sidebar is resized.
const RESEARCH_STAGE_MIN_WIDTH = 380;

/** The widest the sidebar may grow in an app `appWidth` wide: until the stage
 * would fall below its minimum, capped by a comfortable absolute maximum. */
export function maxSidebarWidth(appWidth: number): number {
  const available = Math.floor(appWidth - RESEARCH_STAGE_MIN_WIDTH);
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, available));
}

/** `width` within the sidebar's bounds, on a whole CSS pixel so its 1px
 * separator cannot be antialiased across two adjacent pixel columns. */
export function clampSidebarWidth(width: number, appWidth: number): number {
  return Math.round(clamp(width, SIDEBAR_MIN_WIDTH, maxSidebarWidth(appWidth)));
}
