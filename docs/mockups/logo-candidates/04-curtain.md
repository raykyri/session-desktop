# 04-curtain

- Concept: five open, tapered blades in a vortex sweep around an empty centre disc. Each blade is one shape with one gradient (pale green at the root, teal mid-blade, violet and partly transparent at the tip), standing in for an aurora curtain that fades as it rises.
- Geometry: a blade is the region between two spirals sharing `r(t) = r0 + (r1 - r0)·t`. The leading edge is `θ = sweep·t^0.9`; the trailing edge lags it by `span·(1-t)^taper`, so the two meet at the tip. The root is an arc of the inner circle, which makes the hollow an exact circle. The blade is repeated at 72° steps.
- Colour and mono share the same path. The colour file adds the gradient and one blurred copy at 40% opacity as glow; the mono file is the five paths in `currentColor`.
- Parameters (512 viewBox): `n` 5, `r0` 84 (hollow radius), `r1` 236, `sweep` 92° (how far each blade wraps), `span` 42° (root width; 72° would close the ring), `taper` 1.0 (higher = thinner tips), gradient stops, glow `stdDeviation` 12.
- As a glyph field: density is highest along each blade near the root and falls off toward the tip, following the same two-spiral region.
