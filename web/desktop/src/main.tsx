// The Desktop app's entry: the bridge (Tauri's, or the test's under
// Playwright), the platform the client reads (`platform.ts`), then the
// sign-in, the client's screens, or the storage problem (the person's
// replica could not be opened).

import { ClientApp, meResource, setPlatform } from "@session/client/shell";
import { useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { SignIn } from "./SignIn.js";
import { StorageProblem } from "./StorageProblem.js";
import type { DesktopBridge } from "./bridge.js";
import { Desktop } from "./platform.js";
import { inTauri, tauriBridge } from "./tauri.js";
import { testBridge, testBridgeCall } from "./testBridge.js";
import "./app.css";

function bridge(): DesktopBridge | null {
  if (inTauri()) return tauriBridge();
  const call = testBridgeCall();
  return call ? testBridge(call) : null;
}

function DesktopRoot({ desktop }: { desktop: Desktop }) {
  const state = useSyncExternalStore(
    (l) => desktop.onChange(l),
    () => desktop.state(),
  );
  // a new sign-in reads who is signed in again
  useEffect(() => {
    if (state === "app") void meResource.load(true).catch(() => undefined);
    else meResource.set(null);
  }, [state]);
  if (state === "app") return <ClientApp key={desktop.handle()} />;
  if (state === "storage") return <StorageProblem desktop={desktop} />;
  return <SignIn desktop={desktop} />;
}

async function boot() {
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root element");
  const b = bridge();
  if (!b) {
    root.textContent = "Session for Mac runs in its app.";
    return;
  }
  const desktop = await Desktop.start(b);
  setPlatform(desktop);
  desktop.followTitle();
  createRoot(root).render(<DesktopRoot desktop={desktop} />);
}

void boot();
