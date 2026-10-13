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

// Per-thread browser overlay: the URL it's showing, whether it's visible, a nonce
// bumped when navigation must be replayed, the selected WebKit/Agent engine,
// whether file content needs an opaque-origin sandbox, an optional size, and
// full-width mode.
export type BrowserOverlayState = {
  url: string | null;
  open: boolean;
  reloadNonce: number;
  sandbox: boolean;
  mode: BrowserOverlayMode;
  size?: BrowserOverlaySize | null;
  fullWidth?: boolean;
};
