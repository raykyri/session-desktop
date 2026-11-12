# 06-ribbons: twisted ribbons

Concept: six ribbons leave a hollow center and twist half a turn on the way out. Each one narrows to an edge-on sliver partway along, then opens again with its other face showing, the way a folding aurora curtain looks. The front faces use the brand amber to coral gradient. The back faces run from dark rose through magenta to violet. A lit rim follows the twist axis and crosses over at the fold.

Geometry: each centerline is a circular arc (constant curvature, radius `RHO=125`). It starts at r=62, is launched `BETA=14°` off radial, and ends at r=234. The twist angle `phi` rises linearly from -10° to 190°, and the projected band offset is `(u + ALPHA) * E(t) * cos(phi)` for u in [-1, 1]. The twist axis sits at `ALPHA=0.4`, so the free edge crosses the axis edge at the fold. The width envelope `E` grows from 0.9·W to W=36, then tapers to a point over the last 30% of the length. A smooth floor `hypot(|cos phi|·E, MINW)` keeps the sliver from vanishing. Inner ends are cut on the hollow-center circle r=`RCUT`=74. Edges are sampled and emitted as Catmull-Rom cubic Béziers, and one ribbon is reused with `rotate(60k)`.

Color layers per face: a full-width veil at 55% opacity, a core strip (the half of the width nearest the twist axis) at full strength, and a 10%-width light rim. A blurred copy of the mark at 60% opacity sits underneath as a glow. In a glyph-density field these layers map directly to three density levels plus a halo.

Mono: same construction with W=38, MINW=5 and RCUT=80. Both faces are solid `currentColor`, and the wider waist keeps the ribbons connected at 32px.

Parameters worth tweaking: `N` (ribbon count), `RHO`/`BETA` (radial blades vs. swirl), `PHI0`/`PHI1` (where the fold falls and how far the back face reopens), `ALPHA` (0 gives a symmetric bow-tie twist, 1 twists about one edge), `W`, `RCUT`, `CORE`/`VEIL`/`EDGE`/`GLOW`.
