#!/usr/bin/env python3
"""
ScopeCall logo generator — emits scalable SVGs of the dot-array "C" mark.

The mark is a "C" built from 3 concentric arcs of dots:
  - INNER ring = big dots, OUTER ring = small dots (size shrinks outward)
  - vertical gradient: blue (top) → indigo (middle) → violet (bottom)
  - a bold horizontal "tongue" bar on the left, plus a lower accent capsule

Tune the PARAMETERS block to match the reference, then re-run:
    python3 generate_logo.py
"""
import math

# ─── PARAMETERS — tune these to match your reference ──────────────────────────
CX, CY = 120, 120            # mark center
GAP_HALF_DEG = 38            # half-width of the C opening on the right (try 32–46)

# Vertical gradient stops (top → bottom). Your reference: blue top, violet bottom.
GRAD_TOP = "#2563EB"         # top — blue
GRAD_MID = "#5B54E8"         # middle — indigo
GRAD_BOTTOM = "#8B5CF6"      # bottom — violet

# 3 concentric rings: (radius, dot_radius, dot_count).
# INNER ring has the BIGGEST dots; size shrinks as radius grows.
RINGS = [
    (48, 5.6, 13),   # inner  — big dots
    (70, 4.0, 17),   # middle — medium dots
    (92, 2.7, 21),   # outer  — small dots
]

# Horizontal "tongue"/accent capsules: (x_offset_from_CX, y_offset, width, height)
BAR_CAPSULES = [
    (-64,  0, 26, 9.5),   # bold mid-left tongue (the C's bar)
    (-18, 54, 18, 7.0),   # lower-left accent (the elongated bottom dot)
]
# ──────────────────────────────────────────────────────────────────────────────

START = GAP_HALF_DEG               # arc start angle (deg, math convention, CCW)
END = 360 - GAP_HALF_DEG           # arc end angle
SPAN = END - START


def arc_dots():
    """Even arc-length spacing per ring. Inner ring fewer/bigger dots,
    outer ring more/smaller dots — matches the reference density."""
    out = []
    for (R, dr, n) in RINGS:
        for i in range(n):
            ang = START + SPAN * i / (n - 1)
            rad = math.radians(ang)
            x = CX + R * math.cos(rad)
            y = CY - R * math.sin(rad)   # SVG y is down → subtract
            out.append((x, y, dr))
    return out


def gradient_def(idx="grad"):
    # Vertical, userSpaceOnUse: every dot samples color by its y position.
    return (
        f'<linearGradient id="{idx}" gradientUnits="userSpaceOnUse" '
        f'x1="120" y1="22" x2="120" y2="218">'
        f'<stop offset="0" stop-color="{GRAD_TOP}"/>'
        f'<stop offset="0.5" stop-color="{GRAD_MID}"/>'
        f'<stop offset="1" stop-color="{GRAD_BOTTOM}"/>'
        f'</linearGradient>'
    )


def mark_body(grad="grad"):
    parts = []
    for (x, y, dr) in arc_dots():
        parts.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{dr:.2f}" fill="url(#{grad})"/>')
    for (dx, dy, w, h) in BAR_CAPSULES:
        x = CX + dx - w / 2
        y = CY + dy - h / 2
        parts.append(
            f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" '
            f'rx="{h/2:.2f}" ry="{h/2:.2f}" fill="url(#{grad})"/>'
        )
    return "\n  ".join(parts)


def write_mark():
    open("scopecall-mark.svg", "w").write(
        f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" role="img" aria-label="ScopeCall">
  <defs>{gradient_def()}</defs>
  {mark_body()}
</svg>
''')


def write_app_icon():
    open("scopecall-app-icon.svg", "w").write(
        f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" role="img" aria-label="ScopeCall">
  <defs>{gradient_def()}</defs>
  <rect x="8" y="8" width="224" height="224" rx="52" fill="#08080C"/>
  {mark_body()}
</svg>
''')


def _horizontal_svg(word_fill, bg=None):
    bg_rect = f'<rect x="0" y="0" width="760" height="240" fill="{bg}"/>' if bg else ""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 240" role="img" aria-label="ScopeCall">
  <defs>{gradient_def()}</defs>
  {bg_rect}
  {mark_body()}
  <text x="288" y="122" dominant-baseline="central"
        font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        font-size="104" font-weight="600" letter-spacing="-3" fill="{word_fill}">ScopeCall</text>
</svg>
'''


def write_horizontal():
    open("scopecall-horizontal.svg", "w").write(_horizontal_svg("#FFFFFF"))        # dark bg
    open("scopecall-horizontal-dark.svg", "w").write(_horizontal_svg("#08080C"))    # light bg


if __name__ == "__main__":
    write_mark()
    write_app_icon()
    write_horizontal()
    total = sum(n for _, _, n in RINGS) + len(BAR_CAPSULES)
    print(f"Wrote 4 SVGs. Dots: {sum(n for _,_,n in RINGS)} + {len(BAR_CAPSULES)} bars  |  gap: {2*GAP_HALF_DEG}°  |  rings: {len(RINGS)}")
