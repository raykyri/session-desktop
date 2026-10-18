import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BACKDROP_BLANK_SHARE,
  BACKDROP_GLYPHS,
  BACKDROP_WIND,
  backdropClearing,
  backdropDensity,
  backdropMaskSize,
  backdropRandom,
  backdropRegion,
  backdropRegionFade,
  createBackdropNoise,
  fillBackdropMask,
  nextBackdropCell,
} from "../src/lib/researchBackdrop";
import ResearchColumns from "../src/components/research/ResearchColumns";

const stylesDirectory = join(import.meta.dirname, "..", "src", "styles", "features");
const surfaceCss = readFileSync(join(stylesDirectory, "research-surface.css"), "utf8");
const researchCss = readFileSync(join(stylesDirectory, "research.css"), "utf8");

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|[}\\n])[ \\t]*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("the noise is seeded and stays within [-1, 1]", () => {
  const first = createBackdropNoise(7);
  const second = createBackdropNoise(7);
  const other = createBackdropNoise(8);
  const random = backdropRandom(1);
  let differs = false;
  for (let sample = 0; sample < 5000; sample += 1) {
    const [x, y, z] = [random() * 80 - 40, random() * 80 - 40, random() * 80];
    const value = first(x, y, z);
    assert.equal(value, second(x, y, z));
    assert.ok(value >= -1 && value <= 1, `${value} out of range`);
    if (value !== other(x, y, z)) differs = true;
  }
  assert.ok(differs, "another seed gives another field");
});

test("cloud density is in [0, 1], leaves gaps, and drifts with the wind", () => {
  const noise = createBackdropNoise(0x5e55);
  let empty = 0;
  let full = 0;
  for (let y = 0; y < 900; y += 15) {
    for (let x = 0; x < 1500; x += 15) {
      const value = backdropDensity(noise, x, y, 40);
      assert.ok(value >= 0 && value <= 1);
      if (value === 0) empty += 1;
      if (value > 0.5) full += 1;
    }
  }
  assert.ok(empty > 0 && full > 0, "both clear sky and dense cloud");
  // A second later the field has moved with the wind and barely changed shape:
  // the point the wind carried matches better than the point that stayed.
  let carried = 0;
  let stayed = 0;
  for (let y = 0; y < 900; y += 10) {
    for (let x = 0; x < 1500; x += 10) {
      const before = backdropDensity(noise, x, y, 40);
      carried += Math.abs(backdropDensity(noise, x + BACKDROP_WIND.x, y + BACKDROP_WIND.y, 41) - before);
      stayed += Math.abs(backdropDensity(noise, x, y, 41) - before);
    }
  }
  assert.ok(carried < stayed / 2, `carried ${carried} vs stayed ${stayed}`);
});

test("the shown region's edges fade the field to nothing", () => {
  const region = { left: 100, top: 0, right: 600, bottom: 800 };
  assert.equal(backdropRegionFade(100, 400, region), 0);
  assert.equal(backdropRegionFade(600, 400, region), 0);
  assert.equal(backdropRegionFade(50, 400, region), 0);
  assert.equal(backdropRegionFade(350, 400, region), 1);
  assert.ok(backdropRegionFade(130, 400, region) > 0 && backdropRegionFade(130, 400, region) < 1);
});

test("text in the filler keeps a clearing around it", () => {
  const hint = [{ left: 200, top: 400, right: 400, bottom: 440 }];
  assert.ok(backdropClearing(300, 420, hint) < 0.2);
  assert.ok(backdropClearing(300, 470, hint) < 1);
  assert.equal(backdropClearing(300, 520, hint), 1);
  assert.equal(backdropClearing(300, 420, []), 1);
});

test("the mask is transparent outside the region and fades in with its strength", () => {
  const noise = createBackdropNoise(0x5e55);
  const { columns, rows } = backdropMaskSize(1200, 800);
  const target = new Uint8ClampedArray(columns * rows * 4);
  const region = { left: 600, top: 0, right: 1200, bottom: 800 };
  let visible = false;
  for (let time = 0; time < 50 && !visible; time += 5) {
    visible = fillBackdropMask(target, columns, rows, noise, time, region, []);
  }
  assert.ok(visible);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const alpha = target[(row * columns + column) * 4 + 3];
      if (column * 20 <= 600) assert.equal(alpha, 0, `sample ${column},${row} outside`);
    }
  }
  assert.equal(fillBackdropMask(target, columns, rows, noise, 0, region, [], 0), false);
  assert.ok(target.every((value) => value === 0));
  assert.equal(
    fillBackdropMask(target, columns, rows, noise, 0, { left: 10, top: 0, right: 10, bottom: 800 }, []),
    false,
  );
});

test("cells are a blank about a third of the time, otherwise a glyph in a dim band or bright", () => {
  const random = backdropRandom(3);
  let blanks = 0;
  const count = 20000;
  for (let index = 0; index < count; index += 1) {
    const cell = nextBackdropCell(random);
    assert.ok(cell.glyph >= 0 && cell.glyph < BACKDROP_GLYPHS.length);
    assert.ok(cell.brightness === 1 || (cell.brightness >= 0.4 && cell.brightness <= 0.75));
    if (BACKDROP_GLYPHS[cell.glyph] === " ") blanks += 1;
  }
  assert.ok(Math.abs(blanks / count - BACKDROP_BLANK_SHARE) < 0.02);
});

test("closed, the field shows in the visible part of the filler", () => {
  const filler = { left: 1250, top: 0, right: 1500, bottom: 900 };
  assert.deepEqual(backdropRegion([filler], 1500, 900, false, 0), filler);
  // The strip's resize slack joins the filler.
  assert.deepEqual(
    backdropRegion([{ ...filler, right: 1400 }, { left: 1400, top: 0, right: 1500, bottom: 900 }], 1500, 900, false, 0),
    filler,
  );
  // Home's filler sits under the header bar.
  assert.deepEqual(backdropRegion([{ ...filler, top: 44 }], 1500, 900, false, 0), { ...filler, top: 44 });
  // Scrolled partly out of view, or entirely.
  assert.deepEqual(backdropRegion([{ ...filler, right: 1700 }], 1500, 900, false, 0), filler);
  assert.equal(backdropRegion([{ left: 1600, top: 0, right: 1700, bottom: 900 }], 1500, 900, false, 0), null);
  assert.equal(backdropRegion([{ left: 1500, top: 0, right: 1500, bottom: 900 }], 1500, 900, false, 0), null);
  assert.equal(backdropRegion([], 1500, 900, false, 0), null);
});

test("open, the field follows the strip's trailing edge as it slides out", () => {
  // At rest the filler starts at 1250; halfway out it starts at 500.
  const filler = { left: 1250, top: 44, right: 1500, bottom: 900 };
  assert.deepEqual(backdropRegion([filler], 1500, 900, true, 0), { left: 1250, top: 0, right: 1500, bottom: 900 });
  const halfway = { ...filler, left: 500, right: 750 };
  assert.deepEqual(backdropRegion([halfway], 1500, 900, true, -750), { left: 500, top: 0, right: 1500, bottom: 900 });
  // All the way out, everything.
  const out = { ...filler, left: -250, right: 0 };
  assert.deepEqual(backdropRegion([out], 1500, 900, true, -1500), { left: 0, top: 0, right: 1500, bottom: 900 });
  // A filler scrolled out of view, or none, counts as starting at the right
  // edge, so the field still fills the area once the strip is gone.
  const beyond = { left: 2100, top: 0, right: 2400, bottom: 900 };
  assert.deepEqual(backdropRegion([beyond], 1500, 900, true, -1500), { left: 0, top: 0, right: 1500, bottom: 900 });
  assert.deepEqual(backdropRegion([], 1500, 900, true, -750), { left: 750, top: 0, right: 1500, bottom: 900 });
  assert.equal(backdropRegion([], 1500, 900, true, 0), null);
});

test("the backdrop canvas sits under the strip, and the expand button waits for room", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchColumns, { hasThread: false, feed: null, children: createElement("p", null, "Hint") }),
  );
  assert.match(html, /<div class="research-columns"[^>]*><canvas class="research-backdrop" aria-hidden="true"><\/canvas><div class="research-columns-row">/);
  assert.doesNotMatch(html, /research-backdrop-toggle|research-backdrop-drag|inert/);
});

test("the strip paints over the backdrop without a stacking context, and its empty space is transparent", () => {
  const row = ruleBody(surfaceCss, ".research-columns-row");
  assert.match(row, /position:\s*relative/);
  assert.doesNotMatch(row, /z-index|isolation/);
  const backdrop = ruleBody(surfaceCss, ".research-backdrop");
  assert.match(backdrop, /position:\s*absolute/);
  assert.match(backdrop, /background:\s*var\(--research-page-bg\)/);
  assert.match(backdrop, /color:\s*var\(--research-backdrop-glyph\)/);
  assert.match(ruleBody(surfaceCss, ".research-strip-slack"), /background:\s*transparent/);
  assert.match(ruleBody(researchCss, ".research-columns-filler"), /background:\s*transparent/);
  assert.doesNotMatch(ruleBody(researchCss, ".research-empty-content"), /background/);
  // Open, the strip leaves the tab order and the accessibility tree (inert,
  // from ResearchColumns) and stops painting once it has slid away.
  assert.match(
    ruleBody(surfaceCss, ".research-columns.is-backdrop-open > .research-columns-row"),
    /transform:\s*translateX\(-100%\)[\s\S]*visibility:\s*hidden/,
  );
});
