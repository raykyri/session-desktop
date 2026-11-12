# 04-curtain

- Concept: eight open spiral blades around a hollow disc. Each blade is a bright leading edge with a ragged aurora curtain rising from its outer (convex) side; colour runs green → teal → violet and fades to transparent at the tip.
- Geometry: the leading edge is a polar curve `r = r0 + (rEnd - r0)·t^0.92`, `θ = sweep·t^0.8`, `t ∈ [0,1]`. The curtain is the edge offset along its normal by `W·(1-t)^1.1·smoothstep(t/0.22)`, drawn as 16 stacked low-opacity layers (blurred) plus 22 thin tapered rays of pseudo-random length. Blades alternate long/short (C4 symmetry), each rotated by 45°.
- Finishing: a blurred copy of the whole mark supplies the glow; a radial mask keeps the centre disc empty.
- Parameters to tweak (512 viewBox): `r0` 64 (hollow radius), `rLong`/`rShort` 236/184, `sweepLong`/`sweepShort` 118°/96°, `wLong`/`wShort` 54/42 (curtain depth), ray count, gradient stops, glow `stdDeviation` 14.
- Mono version: the same eight blades as solid `currentColor` fills (no rays, wider root, `r0` 66) so it holds at 32px.
- As a glyph field: density = distance-to-edge falloff on the outer side of each spiral, with the rays mapping to radial character streaks.
