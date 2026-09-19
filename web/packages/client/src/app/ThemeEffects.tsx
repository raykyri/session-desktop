import { APP_TEXT_SIZE, clamp } from "@session/shared";
import { useEffect, useLayoutEffect } from "react";

import { bodyFontStackFor, detectAvailableBodyFonts } from "../lib/bodyFonts.js";
import { useSettingsStore } from "../stores/settings.js";

/**
 * Writes the settings store onto `<html>` (07 §2, ported from
 * `App.tsx:1926-1969`): `data-color-theme`, `data-appearance`,
 * `data-body-font`, the `--font-ui` stack, the `reduce-motion` class, and the
 * `color-scheme` meta that replaces the desktop's `getCurrentWindow().setTheme`.
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

  useLayoutEffect(() => {
    document.documentElement.dataset["colorTheme"] = settings.colorTheme;
  }, [settings.colorTheme]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset["appearance"] = settings.appearance;
    // Synchronizes color-scheme meta tags for native controls, scrollbars, and embedded iframe contexts.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "color-scheme";
      document.head.appendChild(meta);
    }
    meta.content = settings.appearance;
  }, [settings.appearance]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-ui", bodyFontFamily);
    // `data-body-font` drives the optical size offset for faces that sit high
    // in their control boxes (`--font-ui-size-offset`).
    root.dataset["bodyFont"] = settings.bodyFontId;
  }, [bodyFontFamily, settings.bodyFontId]);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", settings.reduceMotion);
  }, [settings.reduceMotion]);

  // App text size adjusts reading surface zoom via CSS variables rather than root font size, as layout tokens are pixel-based. It becomes `--app-text-zoom`, which `prose.css` folds into the
  // reading surface's body size (the desktop's `--turn-font-delta`).
  useLayoutEffect(() => {
    const zoom = clamp((settings.textSize - APP_TEXT_SIZE) * 0.25, 0, 1);
    document.documentElement.style.setProperty("--app-text-zoom", `${zoom}px`);
  }, [settings.textSize]);

  // Inter is an optional local font; if unavailable on the client system, fall back to default system fonts.
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
