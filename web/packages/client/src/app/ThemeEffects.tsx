import { APP_TEXT_SIZE, APP_TEXT_SIZE_MAX, APP_TEXT_SIZE_MIN, clamp } from "@session/shared";
import { useEffect, useLayoutEffect } from "react";

import { useResolvedAppearance } from "../lib/appearance.js";
import { bodyFontStackFor, detectAvailableBodyFonts } from "../lib/bodyFonts.js";
import { useSettingsStore } from "../stores/settings.js";

/**
 * Writes the settings store onto `<html>` (07 §2, ported from
 * `App.tsx:1926-1969`): `data-color-theme`, `data-appearance`,
 * `data-body-font`, the `--font-ui` stack, and the `color-scheme` meta that
 * replaces the desktop's `getCurrentWindow().setTheme`. Reduced motion follows
 * the OS preference alone (`prefers-reduced-motion` in `prose.css`).
 *
 * Everything runs in a layout effect so the attributes land before paint —
 * switching or restoring a theme must not flash the default palette. The
 * attributes go on the document root rather than the shell because menus,
 * dialogs and toasts portal to `document.body` and inherit from their DOM
 * parent, not their React owner.
 *
 * Renders nothing.
 */
export function ThemeEffects() {
  const settings = useSettingsStore((state) => state.settings);
  const patch = useSettingsStore((state) => state.patch);
  const bodyFontFamily = bodyFontStackFor(settings.bodyFontId);
  // "system" resolves against the OS preference and tracks it live.
  const appearance = useResolvedAppearance(settings.appearance);

  useLayoutEffect(() => {
    document.documentElement.dataset["colorTheme"] = settings.colorTheme;
  }, [settings.colorTheme]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset["appearance"] = appearance;
    // Synchronizes color-scheme meta tags for native controls, scrollbars, and embedded iframe contexts.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "color-scheme";
      document.head.appendChild(meta);
    }
    meta.content = appearance;
  }, [appearance]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-ui", bodyFontFamily);
    // `data-body-font` drives the optical size offset for faces that sit high
    // in their control boxes (`--font-ui-size-offset`).
    root.dataset["bodyFont"] = settings.bodyFontId;
  }, [bodyFontFamily, settings.bodyFontId]);

  // App text size adjusts reading surface zoom via CSS variables rather than root font size, as layout tokens are pixel-based. It becomes `--app-text-zoom`, which `prose.css` folds into the
  // reading surface's body size (the desktop's `--turn-font-delta`).
  useLayoutEffect(() => {
    const zoom = clamp(
      settings.textSize - APP_TEXT_SIZE,
      APP_TEXT_SIZE_MIN - APP_TEXT_SIZE,
      APP_TEXT_SIZE_MAX - APP_TEXT_SIZE,
    );
    document.documentElement.style.setProperty("--app-text-zoom", `${zoom}px`);
  }, [settings.textSize]);

  // Optional local faces (none on the web after Inter was bundled) fall back
  // if `FontFace` cannot load them from the host.
  useEffect(() => {
    let disposed = false;
    void detectAvailableBodyFonts().then((available) => {
      if (disposed) return;
      if (available.some((option) => option.id === settings.bodyFontId)) return;
      const fallback = available[0];
      if (fallback) patch({ bodyFontId: fallback.id });
    });
    return () => {
      disposed = true;
    };
  }, [settings.bodyFontId, patch]);

  return null;
}
