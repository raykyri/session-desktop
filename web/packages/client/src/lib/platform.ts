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
