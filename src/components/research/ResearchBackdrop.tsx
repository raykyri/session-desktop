import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import {
  BACKDROP_FLICKER_RATE,
  BACKDROP_FONT_SIZE,
  BACKDROP_GLYPHS,
  BACKDROP_LINE_HEIGHT,
  BACKDROP_MASK_SPACING,
  backdropMaskSize,
  backdropRegion,
  createBackdropNoise,
  fillBackdropMask,
  nextBackdropCell,
  type BackdropRect,
} from "../../lib/researchBackdrop";

/** closed: the field shows in the filler. open: the strip has slid out to the
 * left and the field fills the column area. closing: the strip is sliding
 * back. */
export type ResearchBackdropMode = "closed" | "open" | "closing";

/** The strip's empty space: the filler past the last column (or the Home
 * placeholder's) and the slack a resize leaves after it. */
const FILLER_SELECTOR = ".research-columns-filler, .research-strip-slack";
/** Text in the filler, which the field fades around. */
const HINT_SELECTOR = ".research-columns-filler > p";
/** Frame intervals: focused (about 24 frames a second once a timer's frame
 * waits for the display's), and with the window in the background. A moving
 * region (a scroll or the slide) is followed every display frame. */
const FRAME_INTERVAL = 1000 / 30;
const BLURRED_FRAME_INTERVAL = 1000 / 8;
/** How often a hidden or static field checks the layout again. */
const IDLE_INTERVAL = 400;
const STATIC_INTERVAL = 250;
/** Seconds the field takes to fade in when it appears. */
const FADE_IN = 1.2;
/** The narrowest filler that shows the expand button. */
const TOGGLE_MIN_WIDTH = 96;
/** Device pixel ratio cap, and the most pixels each of the two full-size
 * canvases may hold (about 32 MB): a very large window draws the glyphs at a
 * lower ratio. */
const MAX_RATIO = 2;
const MAX_PIXELS = 8_000_000;

interface BackdropLoop {
  /** Draws a frame now, after the mode or the layout changed. */
  wake: () => void;
  stop: () => void;
}

/** Runs the field on `canvas` (which covers the column area, its parent) for
 * the empty space in `row`, the column strip. */
function runBackdrop(
  canvas: HTMLCanvasElement,
  row: HTMLElement,
  options: {
    mode: () => ResearchBackdropMode;
    reduced: () => boolean;
    /** Whether the filler is wide enough at the top right for the button. */
    onToggleRoom: (room: boolean) => void;
  },
): BackdropLoop {
  const root = canvas.parentElement;
  const context = canvas.getContext("2d");
  const glyphLayer = document.createElement("canvas");
  const glyphContext = glyphLayer.getContext("2d");
  const atlas = document.createElement("canvas");
  const atlasContext = atlas.getContext("2d");
  const mask = document.createElement("canvas");
  const maskContext = mask.getContext("2d");
  if (!root || !context || !glyphContext || !atlasContext || !maskContext) {
    return { wake: () => {}, stop: () => {} };
  }

  const noise = createBackdropNoise(0x5e55);
  const requestedFonts = new Set<string>();
  const random = Math.random;
  let width = 0;
  let height = 0;
  let ratio = 1;
  /** Cell size in CSS pixels, a whole number of device pixels. */
  let cellWidth = 7;
  let cellHeight = BACKDROP_LINE_HEIGHT;
  let columns = 0;
  let rows = 0;
  let glyphs = new Uint8Array(0);
  let brightness = new Float32Array(0);
  let maskSize = { columns: 1, rows: 1 };
  let maskData: ImageData | null = null;
  let styleStale = true;
  /** The canvas area the last frame drew, in device pixels. */
  let drawn: { left: number; top: number; width: number; height: number } | null = null;
  // Start somewhere along the field's path so each launch looks different.
  let time = random() * 600;
  let presence = 0;
  let lastDraw = 0;
  let lastKey = "";
  let flickerCarry = 0;
  let maskSkipped = false;
  let frameHandle = 0;
  let timerHandle = 0;
  let stopped = false;

  const cellLeft = (column: number) => Math.round(column * cellWidth * ratio);
  const cellTop = (line: number) => Math.round(line * cellHeight * ratio);

  const drawCell = (index: number) => {
    const column = index % columns;
    const line = (index - column) / columns;
    const x = cellLeft(column);
    const y = cellTop(line);
    const w = cellLeft(column + 1) - x;
    const h = cellTop(line + 1) - y;
    glyphContext.clearRect(x, y, w, h);
    glyphContext.globalAlpha = brightness[index];
    const slot = Math.round(cellWidth * ratio);
    glyphContext.drawImage(atlas, glyphs[index] * slot, 0, slot, h, x, y, w, h);
  };

  const redrawGlyphs = () => {
    glyphContext.setTransform(1, 0, 0, 1, 0, 0);
    glyphContext.globalAlpha = 1;
    glyphContext.clearRect(0, 0, glyphLayer.width, glyphLayer.height);
    for (let index = 0; index < glyphs.length; index += 1) drawCell(index);
  };

  /** Reads the glyph color and font from the canvas's CSS and renders each
   * glyph once into the atlas. Canvas text does not load a web font by
   * itself: the face is requested once and the atlas rebuilt when it
   * arrives (a `loadingdone` event). */
  const buildAtlas = () => {
    const style = getComputedStyle(canvas);
    const font = `${BACKDROP_FONT_SIZE * ratio}px ${style.fontFamily || "monospace"}`;
    if (document.fonts && !requestedFonts.has(font) && !document.fonts.check(font)) {
      requestedFonts.add(font);
      void document.fonts.load(font).catch(() => undefined);
    }
    atlasContext.font = font;
    cellWidth = Math.max(1, Math.round(atlasContext.measureText("0").width)) / ratio;
    cellHeight = Math.max(1, Math.round(BACKDROP_LINE_HEIGHT * ratio)) / ratio;
    const slot = Math.round(cellWidth * ratio);
    atlas.width = slot * BACKDROP_GLYPHS.length;
    atlas.height = Math.round(cellHeight * ratio);
    // Resizing the canvas reset its state.
    atlasContext.font = font;
    atlasContext.fillStyle = style.color;
    atlasContext.textAlign = "center";
    atlasContext.textBaseline = "middle";
    for (let index = 0; index < BACKDROP_GLYPHS.length; index += 1) {
      atlasContext.fillText(BACKDROP_GLYPHS[index], index * slot + slot / 2, atlas.height / 2);
    }
  };

  /** Sizes the canvases and the grid to the column area. Cells the old grid
   * had keep their glyphs (the grid starts at the area's top left), so a
   * resize or a new glyph color does not reshuffle the field. */
  const layout = (nextWidth: number, nextHeight: number, nextRatio: number) => {
    width = nextWidth;
    height = nextHeight;
    ratio = nextRatio;
    // Resizing a canvas clears it.
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    drawn = null;
    glyphLayer.width = canvas.width;
    glyphLayer.height = canvas.height;
    buildAtlas();
    styleStale = false;
    const nextColumns = Math.ceil(width / cellWidth);
    const nextRows = Math.ceil(height / cellHeight);
    const nextGlyphs = new Uint8Array(nextColumns * nextRows);
    const nextBrightness = new Float32Array(nextColumns * nextRows);
    for (let line = 0; line < nextRows; line += 1) {
      for (let column = 0; column < nextColumns; column += 1) {
        const index = line * nextColumns + column;
        if (line < rows && column < columns) {
          nextGlyphs[index] = glyphs[line * columns + column];
          nextBrightness[index] = brightness[line * columns + column];
        } else {
          const cell = nextBackdropCell(random);
          nextGlyphs[index] = cell.glyph;
          nextBrightness[index] = cell.brightness;
        }
      }
    }
    columns = nextColumns;
    rows = nextRows;
    glyphs = nextGlyphs;
    brightness = nextBrightness;
    redrawGlyphs();
    maskSize = backdropMaskSize(width, height);
    mask.width = maskSize.columns;
    mask.height = maskSize.rows;
    maskData = maskContext.createImageData(maskSize.columns, maskSize.rows);
    lastKey = "";
  };

  /** Changes about `rate` glyphs per cell per second inside `region`. */
  const flicker = (region: BackdropRect, seconds: number) => {
    const first = Math.max(0, Math.floor(region.left / cellWidth));
    const last = Math.min(columns, Math.ceil(region.right / cellWidth));
    const top = Math.max(0, Math.floor(region.top / cellHeight));
    const bottom = Math.min(rows, Math.ceil(region.bottom / cellHeight));
    const span = last - first;
    const lines = bottom - top;
    if (span <= 0 || lines <= 0) return;
    flickerCarry += span * lines * BACKDROP_FLICKER_RATE * seconds;
    const count = Math.floor(flickerCarry);
    flickerCarry -= count;
    for (let change = 0; change < count; change += 1) {
      const index = (top + Math.floor(random() * lines)) * columns + first + Math.floor(random() * span);
      const cell = nextBackdropCell(random);
      glyphs[index] = cell.glyph;
      brightness[index] = cell.brightness;
      drawCell(index);
    }
  };

  const clear = () => {
    if (!drawn) return;
    context.clearRect(drawn.left, drawn.top, drawn.width, drawn.height);
    drawn = null;
  };

  const relative = (rect: DOMRect, origin: DOMRect): BackdropRect => ({
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    right: rect.right - origin.left,
    bottom: rect.bottom - origin.top,
  });

  const schedule = (delay: number) => {
    if (stopped || frameHandle || timerHandle) return;
    if (delay <= 0) {
      frameHandle = requestAnimationFrame(frame);
    } else {
      timerHandle = window.setTimeout(() => {
        timerHandle = 0;
        schedule(0);
      }, delay);
    }
  };

  const frame = (now: number) => {
    frameHandle = 0;
    if (stopped) return;
    const nextWidth = root.clientWidth;
    const nextHeight = root.clientHeight;
    if (nextWidth === 0 || nextHeight === 0 || !row.isConnected) {
      clear();
      options.onToggleRoom(false);
      schedule(IDLE_INTERVAL);
      return;
    }
    const nextRatio = Math.min(
      MAX_RATIO,
      window.devicePixelRatio || 1,
      Math.sqrt(MAX_PIXELS / (nextWidth * nextHeight)),
    );
    if (styleStale || nextWidth !== width || nextHeight !== height || nextRatio !== ratio) {
      layout(nextWidth, nextHeight, nextRatio);
    }

    const mode = options.mode();
    const origin = root.getBoundingClientRect();
    const fillers = [...row.querySelectorAll<HTMLElement>(FILLER_SELECTOR)].map((element) =>
      relative(element.getBoundingClientRect(), origin),
    );
    const shift = row.getBoundingClientRect().left - origin.left;
    const region = backdropRegion(fillers, width, height, mode !== "closed", shift);
    // Room for the button is judged with the strip at rest, so the button
    // stays (and keeps focus) while the strip slides.
    const resting = backdropRegion(
      fillers.map((filler) => ({ ...filler, left: filler.left - shift, right: filler.right - shift })),
      width,
      height,
      false,
      0,
    );
    options.onToggleRoom(
      resting !== null && resting.right >= width - 1 && resting.right - resting.left >= TOGGLE_MIN_WIDTH,
    );
    if (!region) {
      clear();
      presence = 0;
      lastDraw = 0;
      lastKey = "";
      // While the strip slides, the region can open up on any frame.
      schedule(mode === "closed" ? IDLE_INTERVAL : 0);
      return;
    }

    // A moving region (a scroll, the slide) is followed every display frame;
    // a still one is redrawn at the frame rate, or not at all when static.
    const reduced = options.reduced();
    const key = `${mode}:${region.left}:${region.top}:${region.right}:${region.bottom}`;
    const moved = key !== lastKey;
    const interval = reduced ? STATIC_INTERVAL : document.hasFocus() ? FRAME_INTERVAL : BLURRED_FRAME_INTERVAL;
    if (!moved && (reduced || now - lastDraw < interval)) {
      schedule(reduced ? interval : interval - (now - lastDraw));
      return;
    }
    const seconds = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 0;
    lastDraw = now;
    lastKey = key;
    if (reduced) {
      presence = 1;
    } else {
      time += seconds;
      presence = Math.min(1, presence + seconds / FADE_IN);
      flicker(region, seconds);
    }

    // The clouds move about a pixel a frame, so a still region's mask is
    // recomputed every other frame.
    maskSkipped = !moved && !reduced && !maskSkipped;
    if (!maskSkipped) {
      // A hint hidden in a narrow filler has an empty rect at the origin.
      const clearings = [...row.querySelectorAll<HTMLElement>(HINT_SELECTOR)]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => relative(rect, origin));
      fillBackdropMask(maskData!.data, maskSize.columns, maskSize.rows, noise, time, region, clearings, presence);
      maskContext.putImageData(maskData!, 0, 0);
    }

    clear();
    const left = Math.floor(region.left * ratio);
    const top = Math.floor(region.top * ratio);
    const area = {
      left,
      top,
      width: Math.ceil(region.right * ratio) - left,
      height: Math.ceil(region.bottom * ratio) - top,
    };
    // The glyphs, then the mask over them; the clip keeps both composites
    // (destination-in otherwise clears the whole canvas) to the region.
    context.save();
    context.beginPath();
    context.rect(area.left, area.top, area.width, area.height);
    context.clip();
    context.drawImage(glyphLayer, area.left, area.top, area.width, area.height, area.left, area.top, area.width, area.height);
    // Mask sample (column, row) lies at (column, row) * spacing: offset the
    // upscaled mask by half a sample so each pixel's centre lands there.
    const spacing = BACKDROP_MASK_SPACING * ratio;
    context.globalCompositeOperation = "destination-in";
    context.imageSmoothingEnabled = true;
    context.drawImage(mask, -spacing / 2, -spacing / 2, maskSize.columns * spacing, maskSize.rows * spacing);
    context.restore();
    drawn = area;
    schedule(moved ? 0 : interval);
  };

  const wake = () => {
    if (stopped) return;
    if (timerHandle) {
      window.clearTimeout(timerHandle);
      timerHandle = 0;
    }
    lastKey = "";
    schedule(0);
  };

  // A theme or font change re-renders the glyphs in the new color and face.
  const restyle = () => {
    styleStale = true;
    wake();
  };
  const themeObserver = new MutationObserver(restyle);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-appearance", "data-color-theme"],
  });
  document.fonts?.addEventListener("loadingdone", restyle);
  const resizeObserver = new ResizeObserver(wake);
  resizeObserver.observe(root);
  row.addEventListener("scroll", wake, { passive: true });
  schedule(0);

  return {
    wake,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(frameHandle);
      window.clearTimeout(timerHandle);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      document.fonts?.removeEventListener("loadingdone", restyle);
      row.removeEventListener("scroll", wake);
    },
  };
}

/** The system's Reduce motion preference. */
function useSystemReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** The glyph field behind the column strip, and the button that slides the
 * strip away to show all of it. The canvas covers the column area under the
 * strip, which paints over it everywhere except its empty space (the
 * filler, which is transparent); the field is drawn only there. Under Reduce
 * motion it is still. */
export function ResearchBackdrop({
  row,
  mode,
  reduceMotion,
  onToggle,
}: {
  row: HTMLElement | null;
  mode: ResearchBackdropMode;
  reduceMotion: boolean;
  onToggle: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loopRef = useRef<BackdropLoop | null>(null);
  const systemReduced = useSystemReducedMotion();
  const reduced = reduceMotion || systemReduced;
  const modeRef = useRef(mode);
  const reducedRef = useRef(reduced);
  const [toggleRoom, setToggleRoom] = useState(false);

  useLayoutEffect(() => {
    modeRef.current = mode;
    reducedRef.current = reduced;
    loopRef.current?.wake();
  }, [mode, reduced]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !row) return;
    const loop = runBackdrop(canvas, row, {
      mode: () => modeRef.current,
      reduced: () => reducedRef.current,
      onToggleRoom: setToggleRoom,
    });
    loopRef.current = loop;
    return () => {
      loop.stop();
      loopRef.current = null;
    };
  }, [row]);

  const open = mode === "open";
  return (
    <>
      <canvas ref={canvasRef} className="research-backdrop" aria-hidden="true" />
      {/* With the strip slid away, its headers no longer move the window. */}
      {mode !== "closed" ? <div className="research-backdrop-drag" data-tauri-drag-region /> : null}
      {toggleRoom || mode !== "closed" ? (
        <button
          type="button"
          className="research-backdrop-toggle"
          aria-pressed={open}
          aria-label="Expand background"
          title={open ? "Show the columns (Esc)" : "Expand background"}
          onClick={onToggle}
        >
          {open ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
        </button>
      ) : null}
    </>
  );
}
