// The body-font options behind the Appearance settings row, ported from the
// desktop `src/lib/settings.ts`. `UserSettings.bodyFontId` (shared) is an id
// into this list, which is client-only: the server stores the id and never
// needs to know the stack.
//
// DM Sans, Valley Sans, JetBrains Mono and Ioskeley Mono are bundled under the
// SIL OFL 1.1 (`styles/fonts.css`). Anthropic Sans Text and Inter are not
// bundled; they are offered only when `FontFace` can load them from the host,
// which is what `detectAvailableBodyFonts` probes.

export interface BodyFontOption {
  id: string;
  label: string;
  /** Full CSS font-family stack applied to the application UI. */
  stack: string;
  /** Full/PostScript local face names used to verify an optional installed font. */
  localNames?: readonly string[];
}

const SYSTEM_BODY_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const BODY_FONT_OPTIONS: readonly BodyFontOption[] = [
  { id: "dm-sans", label: "DM Sans", stack: `"DM Sans", ${SYSTEM_BODY_FONT_STACK}` },
  {
    id: "anthropic-sans-text",
    label: "Anthropic Sans Text",
    stack: `"Anthropic Sans Text", ${SYSTEM_BODY_FONT_STACK}`,
    localNames: ["Anthropic Sans Text Regular", "AnthropicSansText-Regular"],
  },
  { id: "valley-sans", label: "Valley Sans", stack: `"Valley Sans", ${SYSTEM_BODY_FONT_STACK}` },
  {
    id: "inter",
    label: "Inter",
    stack: `"Inter", ${SYSTEM_BODY_FONT_STACK}`,
    localNames: ["Inter Regular", "Inter-Regular"],
  },
  { id: "system", label: "System", stack: SYSTEM_BODY_FONT_STACK },
];

export const DEFAULT_BODY_FONT_ID = "dm-sans";
export const SYSTEM_BODY_FONT_ID = "system";

export function bodyFontStackFor(id: string): string {
  return (
    BODY_FONT_OPTIONS.find((option) => option.id === id)?.stack ??
    BODY_FONT_OPTIONS.find((option) => option.id === DEFAULT_BODY_FONT_ID)?.stack ??
    SYSTEM_BODY_FONT_STACK
  );
}

function localFontSource(localName: string): string {
  const escaped = localName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `local("${escaped}")`;
}

async function localFontIsAvailable(localName: string): Promise<boolean> {
  try {
    const probe = new FontFace("__session_local_font_probe__", localFontSource(localName));
    await probe.load();
    return true;
  } catch {
    return false;
  }
}

/** Bundled and generic faces plus any locally installed optional face, in menu
 * order. Environments without `FontFace` (jsdom, older engines) get the bundled
 * subset. */
export async function detectAvailableBodyFonts(): Promise<BodyFontOption[]> {
  if (typeof FontFace === "undefined") {
    return BODY_FONT_OPTIONS.filter((option) => option.localNames === undefined);
  }
  const availability = await Promise.all(
    BODY_FONT_OPTIONS.map(async (option) => {
      if (option.localNames === undefined) return true;
      const matches = await Promise.all(option.localNames.map(localFontIsAvailable));
      return matches.some(Boolean);
    }),
  );
  return BODY_FONT_OPTIONS.filter((_option, index) => availability[index] === true);
}
