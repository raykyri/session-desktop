import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { columnSelector } from "@session/shared/lib/researchColumns";

const GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const hash = (value: number) => {
  const n = Math.sin(value * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
};

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix + iy * 157);
  const b = hash(ix + 1 + iy * 157);
  const c = hash(ix + (iy + 1) * 157);
  const d = hash(ix + 1 + (iy + 1) * 157);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Decorative, theme-colored ASCII wisps. No React updates per frame. */
function AmbientCanvas({ reduceMotion }: { reduceMotion: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Keep the same cloud and character phase when Reduce motion is toggled.
  const elapsedRef = useRef(0);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const contrast = window.matchMedia("(forced-colors: active)");
    let timer = 0;
    let width = 0;
    let height = 0;
    let previous = performance.now();
    let ink = "";
    let font = "";

    const draw = () => {
      context.clearRect(0, 0, width, height);
      if (contrast.matches) return;
      // Bound glyph count on very large displays; the backing store is also
      // capped so this decoration does not allocate a full Retina framebuffer.
      const step = Math.max(1, Math.sqrt((width * height) / 1_600_000));
      const dx = 8 * step;
      const dy = 15 * step;
      const t = elapsedRef.current / 1000;
      context.font = `${11 * step}px ${font}`;
      context.textBaseline = "middle";
      context.fillStyle = ink;
      for (let y = dy / 2, row = 0; y < height; y += dy, row++) {
        for (let x = dx / 2, col = 0; x < width; x += dx, col++) {
          const u = x / Math.max(width, 640);
          const v = y / Math.max(height, 480);
          // Domain-warped, layered noise reveals irregular wisps rather than
          // visible bands. A narrow gap crops a cloud instead of squeezing it.
          const nx = u * 3.6 + 0.65 * Math.sin(v * 4 + t * 0.03) - t * 0.018;
          const ny = v * 4.2 + 0.35 * Math.sin(u * 5 - t * 0.02) + t * 0.01;
          const field = noise(nx, ny) * 0.62 + noise(nx * 2.1, ny * 2.1) * 0.27
            + noise(nx * 4.1, ny * 4.1) * 0.11;
          const cloud = Math.max(0, Math.min(1, (field - 0.46) / 0.34));
          const seed = row * 613 + col * 17;
          const alpha = cloud ** 1.6 * 0.11 * (0.75 + hash(seed) * 0.25);
          if (alpha < 0.004) continue;
          // Each cell changes at its own pace and crossfades, avoiding the
          // flashing, synchronized scramble of a Matrix-style rain effect.
          const phase = t / (3 + hash(seed + 1) * 5) + hash(seed + 2) * 10;
          const epoch = Math.floor(phase);
          const blend = Math.min(1, (phase - epoch) * 5);
          const glyph = (at: number) => GLYPHS[Math.floor(hash(seed + at * 31) * GLYPHS.length)];
          context.globalAlpha = alpha * (1 - blend);
          if (blend < 1) context.fillText(glyph(epoch - 1), x, y);
          context.globalAlpha = alpha * blend;
          context.fillText(glyph(epoch), x, y);
        }
      }
      context.globalAlpha = 1;
    };
    const tick = () => {
      const now = performance.now();
      elapsedRef.current += Math.min(now - previous, 250);
      previous = now;
      draw();
      timer = window.setTimeout(tick, 1000 / 12);
    };
    const refresh = () => {
      window.clearTimeout(timer);
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      if (width < 1 || height < 1) {
        // Release the backing store when a wide thread covers the background.
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      if (document.hidden) return;
      const scale = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2_500_000 / (width * height)));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      const style = getComputedStyle(canvas);
      ink = style.color;
      font = style.getPropertyValue("--font-mono").trim() || "monospace";
      draw();
      if (!reduceMotion && !motion.matches && !contrast.matches) {
        previous = performance.now();
        timer = window.setTimeout(tick, 1000 / 12);
      }
    };
    const resize = new ResizeObserver(refresh);
    resize.observe(canvas);
    const theme = new MutationObserver(refresh);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance", "data-color-theme"] });
    motion.addEventListener("change", refresh);
    contrast.addEventListener("change", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("resize", refresh);
    refresh();
    return () => {
      window.clearTimeout(timer);
      resize.disconnect();
      theme.disconnect();
      motion.removeEventListener("change", refresh);
      contrast.removeEventListener("change", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("resize", refresh);
    };
  }, [reduceMotion]);
  return <canvas ref={ref} className="research-ambient-canvas" aria-hidden="true" />;
}

/** Tracks actual columns, excluding resize slack and Home's empty filler. */
export default function ResearchAmbient({ row, expanded, onExpandedChange, reduceMotion }: {
  row: HTMLDivElement | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  reduceMotion: boolean;
}) {
  const [space, setSpace] = useState({ start: 0, width: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!row) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const columns = row.querySelectorAll<HTMLElement>(columnSelector());
      const last = columns[columns.length - 1];
      const start = Math.max(0, Math.min(row.clientWidth, last ? last.offsetLeft + last.offsetWidth - row.scrollLeft : 0));
      const width = Math.max(0, row.clientWidth - start);
      setSpace((current) => current.start === start && current.width === width ? current : { start, width });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const observeColumns = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      resize.disconnect();
      resize.observe(row);
      for (const column of row.querySelectorAll(columnSelector())) resize.observe(column);
      measure();
    };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
        node instanceof Element && (node.matches(columnSelector()) || node.querySelector(columnSelector())),
      ))) observeColumns();
    });
    mutations.observe(row, { childList: true, subtree: true });
    row.addEventListener("scroll", schedule, { passive: true });
    observeColumns();
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      row.removeEventListener("scroll", schedule);
    };
  }, [row]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Allow menus and dialogs opened from the sidebar to handle Escape.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      event.preventDefault();
      onExpandedChange(false);
      buttonRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded, onExpandedChange]);

  const visible = expanded || space.width >= 72;
  return (
    <>
      <div
        id={id}
        className={`research-ambient${expanded ? " is-expanded" : ""}`}
        style={{ "--ambient-start": `${space.start}px` } as CSSProperties}
        aria-hidden="true"
      >
        <AmbientCanvas reduceMotion={reduceMotion} />
      </div>
      {visible ? (
        <button
          ref={buttonRef}
          type="button"
          className="research-ambient-toggle"
          aria-label={expanded ? "Restore columns" : "Expand background"}
          title={expanded ? "Restore columns (Esc)" : "Expand background"}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
        </button>
      ) : null}
    </>
  );
}
