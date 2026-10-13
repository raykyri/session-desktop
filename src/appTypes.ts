export type ExitDialogState = {
  researchRunCount: number;
};

export type ExitPreflightRequest = {
  researchRunCount: number;
  nonce: number;
};

export type BrowserOverlaySize = {
  width: number;
  height: number;
};

export type BrowserOverlayMode = "webkit" | "agent";

// Per-pane browser overlay: the URL it's showing, whether it's visible, a nonce
// bumped when navigation must be replayed, the selected WebKit/Agent engine,
// whether file content needs an opaque-origin sandbox, and an optional size that
// survives tab switches. Full-width mode also follows the pane across tab switches.
export type BrowserOverlayState = {
  url: string | null;
  open: boolean;
  /** Artifact-tray entry that opened the current page, if any. */
  artifactId?: string | null;
  reloadNonce: number;
  sandbox: boolean;
  mode: BrowserOverlayMode;
  size?: BrowserOverlaySize | null;
  fullWidth?: boolean;
};
