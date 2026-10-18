/** The animated glyph field behind the strip past the last column
 * (ResearchBackdrop): a grid of monospace characters that change at random,
 * shown through a mask of drifting noise clouds. This module holds the parts
 * that need no DOM: the noise, the mask, and the glyph choice. Coordinates are
 * CSS pixels relative to the column area; time is in seconds. */

/** A rectangle in column-area coordinates. */
export interface BackdropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Characters drawn in the field: a blank (index 0), then hexadecimal digits,
 * as in a hash, with a few punctuation marks for texture. */
export const BACKDROP_GLYPHS = " 0123456789abcdef0123456789abcdef+-=*:./";

/** Share of cells left blank at any time, so the field reads as scattered
 * characters rather than lines of text. */
export const BACKDROP_BLANK_SHARE = 0.35;

/** Monospace cell size. */
export const BACKDROP_FONT_SIZE = 12;
export const BACKDROP_LINE_HEIGHT = 16;

/** Spacing of the mask's sample grid. The canvas scales the mask up with
 * bilinear smoothing, so it only needs to resolve the clouds and the fades. */
export const BACKDROP_MASK_SPACING = 20;

/** Average glyph changes per cell per second. */
export const BACKDROP_FLICKER_RATE = 0.55;

/** Deterministic PRNG (mulberry32), returning values in [0, 1). */
export function backdropRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD3 = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0,
  -1, -1,
];
const F3 = 1 / 3;
const G3 = 1 / 6;

type BackdropNoise = (x: number, y: number, z: number) => number;

/** 3D simplex noise (after Stefan Gustavson's reference implementation),
 * seeded, in roughly [-1, 1]. */
export function createBackdropNoise(seed: number): BackdropNoise {
  const random = backdropRandom(seed);
  const source = Array.from({ length: 256 }, (_, index) => index);
  for (let index = 255; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [source[index], source[swap]] = [source[swap], source[index]];
  }
  const perm = new Uint8Array(512);
  const gradient = new Uint8Array(512);
  for (let index = 0; index < 512; index += 1) {
    perm[index] = source[index & 255];
    gradient[index] = (perm[index] % 12) * 3;
  }
  const corner = (g: number, x: number, y: number, z: number) => {
    let t = 0.6 - x * x - y * y - z * z;
    if (t <= 0) return 0;
    t *= t;
    return t * t * (GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z);
  };
  return (xin, yin, zin) => {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    // The simplex this point is in: the second and third corners' offsets,
    // from the order of x0, y0 and z0.
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    let i2 = 1;
    let j2 = 1;
    let k2 = 1;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1;
        k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1;
        j2 = 0;
      } else {
        k1 = 1;
        j2 = 0;
      }
    } else if (y0 < z0) {
      k1 = 1;
      i2 = 0;
    } else if (x0 < z0) {
      j1 = 1;
      i2 = 0;
    } else {
      j1 = 1;
      k2 = 0;
    }
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    return (
      32 *
      (corner(gradient[ii + perm[jj + perm[kk]]], x0, y0, z0) +
        corner(gradient[ii + i1 + perm[jj + j1 + perm[kk + k1]]], x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3) +
        corner(
          gradient[ii + i2 + perm[jj + j2 + perm[kk + k2]]],
          x0 - i2 + 2 * G3,
          y0 - j2 + 2 * G3,
          z0 - k2 + 2 * G3,
        ) +
        corner(gradient[ii + 1 + perm[jj + 1 + perm[kk + 1]]], x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3))
    );
  };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 === edge0) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Wind speed, in pixels per second: right, and slightly up. */
export const BACKDROP_WIND = { x: 26, y: -2.5 };

/** Cloud density at a point, in [0, 1]. Two layers ride the wind together:
 * broad, faint clouds, and wisps (ridged noise, stretched along the wind)
 * that are brighter where they cross the clouds. A low-frequency warp bends
 * both. The wind moves the point before any layer samples it, so the layers
 * keep their shape relative to each other and drift as one; the third noise
 * axis changes the shapes slowly. */
export function backdropDensity(noise: BackdropNoise, x: number, y: number, time: number): number {
  const u = (x - time * BACKDROP_WIND.x) / 520;
  const v = (y - time * BACKDROP_WIND.y) / 240;
  const z = time * 0.008;
  const warp = noise(u * 0.5 + 7.3, v * 0.5 - 3.1, z * 0.6);
  const wu = u + warp * 0.7;
  const wv = v + warp * 0.45;
  const cloud = noise(wu, wv, z) * 0.7 + noise(wu * 2.2 + 11.7, wv * 2.2 - 5.2, z * 1.5) * 0.3;
  const ridge = 1 - Math.abs(noise(wu * 1.4 - 4.6, wv * 2.6 + 9.9, z * 1.2));
  const wisp = ridge * ridge * ridge * ridge;
  return smoothstep(0.22, 0.9, smoothstep(-0.3, 0.6, cloud) * 0.5 + wisp * smoothstep(-0.6, 0.3, cloud) * 0.75);
}

/** How far each edge of the shown region fades the field, in pixels. Each
 * fade is capped to a share of the region so a narrow strip still shows some
 * of it. */
function edgeFades(region: BackdropRect) {
  const width = region.right - region.left;
  const height = region.bottom - region.top;
  return {
    left: Math.min(120, width * 0.35),
    right: Math.min(40, width * 0.12),
    top: Math.min(72, height * 0.15),
    bottom: Math.min(96, height * 0.2),
  };
}

/** Opacity of the field at a point of `region` from its fades; 0 outside. */
export function backdropRegionFade(x: number, y: number, region: BackdropRect): number {
  if (x <= region.left || x >= region.right || y <= region.top || y >= region.bottom) return 0;
  const fades = edgeFades(region);
  return (
    smoothstep(0, fades.left, x - region.left) *
    smoothstep(0, fades.right, region.right - x) *
    smoothstep(0, fades.top, y - region.top) *
    smoothstep(0, fades.bottom, region.bottom - y)
  );
}

/** How much a text block's surroundings keep of the field: little over the
 * text, rising to all of it 48px away. */
export function backdropClearing(x: number, y: number, clearings: readonly BackdropRect[]): number {
  let keep = 1;
  for (const rect of clearings) {
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    keep = Math.min(keep, 0.12 + 0.88 * smoothstep(0, 48, Math.hypot(dx, dy)));
  }
  return keep;
}

/** The mask's sample grid: sample (column, row) lies at (column * spacing,
 * row * spacing). */
export function backdropMaskSize(width: number, height: number, spacing = BACKDROP_MASK_SPACING) {
  return {
    columns: Math.max(1, Math.ceil(width / spacing) + 1),
    rows: Math.max(1, Math.ceil(height / spacing) + 1),
  };
}

/** Writes the mask's alpha (white RGBA) for `region` into `target`, leaving
 * samples outside it transparent, and returns whether any sample is visible.
 * `strength` scales the whole mask (the field fading in). */
export function fillBackdropMask(
  target: Uint8ClampedArray,
  columns: number,
  rows: number,
  noise: BackdropNoise,
  time: number,
  region: BackdropRect,
  clearings: readonly BackdropRect[],
  strength = 1,
  spacing = BACKDROP_MASK_SPACING,
): boolean {
  target.fill(0);
  if (strength <= 0 || region.right <= region.left || region.bottom <= region.top) return false;
  const first = Math.max(0, Math.floor(region.left / spacing));
  const last = Math.min(columns - 1, Math.ceil(region.right / spacing));
  const top = Math.max(0, Math.floor(region.top / spacing));
  const bottom = Math.min(rows - 1, Math.ceil(region.bottom / spacing));
  let visible = false;
  for (let row = top; row <= bottom; row += 1) {
    const y = row * spacing;
    for (let column = first; column <= last; column += 1) {
      const x = column * spacing;
      const fade = backdropRegionFade(x, y, region);
      if (fade <= 0) continue;
      const clearing = clearings.length ? backdropClearing(x, y, clearings) : 1;
      const alpha = Math.round(255 * strength * fade * clearing * backdropDensity(noise, x, y, time));
      if (alpha <= 0) continue;
      const offset = (row * columns + column) * 4;
      target[offset] = 255;
      target[offset + 1] = 255;
      target[offset + 2] = 255;
      target[offset + 3] = alpha;
      visible = true;
    }
  }
  return visible;
}

/** A random glyph index and brightness for a cell. */
export function nextBackdropCell(random: () => number): { glyph: number; brightness: number } {
  const glyph =
    random() < BACKDROP_BLANK_SHARE ? 0 : 1 + Math.floor(random() * (BACKDROP_GLYPHS.length - 1));
  // Most cells sit in a narrow band; one in twelve is brighter.
  const brightness = random() < 1 / 12 ? 1 : 0.4 + random() * 0.35;
  return { glyph, brightness };
}

/** The region the field shows, from the filler's and the strip's rects on
 * screen (relative to the column area, `width` by `height`).
 *
 * Closed: the visible part of the filler (and of the strip's resize slack).
 * Open, or while closing: everything right of where the filler starts once
 * the strip's slide (`shift`, 0 or negative) is applied, from top to bottom,
 * so the field follows the columns' trailing edge as they slide. A filler
 * scrolled out of view on the right counts as starting at the right edge. */
export function backdropRegion(
  fillers: readonly BackdropRect[],
  width: number,
  height: number,
  expanded: boolean,
  shift: number,
): BackdropRect | null {
  let region: BackdropRect | null = null;
  for (const filler of fillers) {
    const rect = {
      left: Math.max(0, filler.left),
      top: Math.max(0, filler.top),
      right: Math.min(width, filler.right),
      bottom: Math.min(height, filler.bottom),
    };
    if (rect.right - rect.left < 1 || rect.bottom - rect.top < 1) continue;
    region = region
      ? {
          left: Math.min(region.left, rect.left),
          top: Math.min(region.top, rect.top),
          right: Math.max(region.right, rect.right),
          bottom: Math.max(region.bottom, rect.bottom),
        }
      : rect;
  }
  if (!expanded) return region;
  // The filler's left edge without the slide.
  const restingLeft = region ? region.left - shift : width;
  const left = Math.max(0, Math.min(width, restingLeft) + shift);
  return left < width ? { left, top: 0, right: width, bottom: height } : null;
}
