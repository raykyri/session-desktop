# 06-ribbons: three twisted streamers

Concept: three ribbons leave a hollow center and sweep outward. Each one makes a single half-twist, shown as two flat tones: an amber front face (#f9b450) near the center and a magenta back face (#cc48a4) after the twist. The color and mono versions have the same geometry. The color version adds only a faint blurred copy (35% opacity) as a glow.

Geometry: each centerline is an Archimedean spiral `r = R0 + k·θ` that sweeps `SWEEP=160°` from r=`R0`=66 to r=`R1`=240. It leaves the center nearly radially and turns more tangential further out. The twist angle `phi` rises linearly from 10° to 200°. The band's half-width is `hypot(W·|cos phi|, MINW)` around the centerline (`W=37`, `MINW=3.5`). This gives one edge-on sliver at about 42% of the length. The last 40% of the length tapers to a point (`TIP`, `TIPEXP`). Edges are sampled and emitted as cubic Béziers, and one ribbon is reused with `rotate(120k)`.

Parameters to tweak: `N` (3 here; 4 hooked arms start to resemble a swastika, so check that before using 4), `SWEEP` (radial versus swirl), `PHI0`/`PHI1` (where the twist falls), `W`/`MINW` (weight and how small it can render), `R0` (hollow size), `FRONT`/`BACK`.
