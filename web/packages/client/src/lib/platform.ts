// Which modifier is the primary one. The composer submit chord is ⌘↵ on Apple
// platforms and Ctrl↵ everywhere else, and the glyph on the button has to say
// which. `navigator.userAgentData.platform` is the current API; `platform` is
// the fallback older engines and jsdom still expose.

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = data?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Renders a chord such as `"mod+shift+h"` or `"mod+enter"` for the current
 * platform: `⇧⌘H` on Apple, `Ctrl+Shift+H` elsewhere. Every hint the UI
 * prints goes through here so no surface advertises a key it cannot take. */
export function formatChord(chord: string, apple: boolean = isApplePlatform()): string {
  const parts = chord.toLowerCase().split("+");
  const key = parts.at(-1) ?? "";
  const mods = parts.slice(0, -1);
  const keyLabel = key === "enter" ? "↵" : key.length === 1 ? key.toUpperCase() : key;
  if (apple) {
    const order = ["ctrl", "alt", "shift", "mod"];
    const glyph: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", mod: "⌘" };
    return (
      order
        .filter((m) => mods.includes(m))
        .map((m) => glyph[m])
        .join("") + keyLabel
    );
  }
  const order = ["ctrl", "mod", "alt", "shift"];
  const name: Record<string, string> = { ctrl: "Ctrl", mod: "Ctrl", alt: "Alt", shift: "Shift" };
  const seen = new Set<string>();
  const labels = order
    .filter((m) => mods.includes(m))
    .map((m) => name[m] as string)
    .filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
  return [...labels, keyLabel].join("+");
}
