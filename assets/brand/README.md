# ScopeCall Brand Assets

Scalable SVG logo assets. All vector — crisp at any size, from 16px favicon to billboard.

## Files

| File | Use |
|------|-----|
| `scopecall-mark.svg` | Mark only (the dot-array "C"). Favicon, app icon source, compact spaces. Transparent background — the gradient dots show on both light and dark. |
| `scopecall-app-icon.svg` | Mark on a rounded dark square (`#08080C`). App icon / social avatar. |
| `scopecall-horizontal.svg` | Mark + "ScopeCall" wordmark, **white** wordmark — for **dark** backgrounds. |
| `scopecall-horizontal-dark.svg` | Mark + "ScopeCall" wordmark, **dark** wordmark — for **light** backgrounds. |
| `generate_logo.py` | Parametric generator. Edit the `PARAMETERS` block and re-run to regenerate all SVGs. |

## Brand colors

| Token | Hex | Where |
|-------|-----|-------|
| Brand blue | `#3B82F6` | gradient, top-right of mark |
| Brand violet | `#7C3AED` | gradient, bottom-left of mark |
| Ink (dark bg) | `#08080C` | app-icon background, dark wordmark |
| White | `#FFFFFF` | wordmark on dark |

The mark gradient runs lower-left (violet) → upper-right (blue).

## Regenerating / tuning

```bash
python3 generate_logo.py
```

Tune in the `PARAMETERS` block of `generate_logo.py`:

- `GAP_HALF_DEG` — half-width of the C opening on the right (bigger = more open C)
- `STEP_DEG` — angular spacing between dot spokes (smaller = denser)
- `RINGS` — `(radius, dot_radius)` per concentric ring; inner small → outer large
- `BAR_CAPSULES` — the short horizontal "tongue" bars on the left
- `BRAND_BLUE` / `BRAND_PURPLE` — gradient endpoints

## Production note — wordmark font

The horizontal lockups set the wordmark in **Inter** (`font-family="Inter, …"`). For pixel-identical rendering everywhere (including environments without Inter installed), **convert the wordmark text to outlines** before final use:

- Figma: select the text → right-click → *Outline stroke* / flatten
- Illustrator: *Type → Create Outlines*
- Inkscape: *Path → Object to Path*

The mark itself is pure geometry (circles + rounded rects) and needs no outlining — it renders identically everywhere as-is.

## Rasterizing (PNG export)

```bash
# macOS Quick Look
qlmanage -t -s 1024 -o . scopecall-mark.svg

# or with rsvg-convert / Inkscape / a browser if you have them
rsvg-convert -w 1024 -h 1024 scopecall-mark.svg > scopecall-mark-1024.png
```
