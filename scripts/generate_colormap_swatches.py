#!/usr/bin/env python3
"""
Generate WebP gradient swatches for every colormap defined in
src/lib/shaders/colormapShaders.ts and write them to
public/static/colormaps/<name>.webp

The GLSL polynomial form is a degree-6 Horner evaluation identical across all
colormaps:
    color = c0 + t*(c1 + t*(c2 + t*(c3 + t*(c4 + t*(c5 + t*c6)))))
"""

import pathlib
import re
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = pathlib.Path(__file__).parent.parent
SHADER_SRC = ROOT / "src" / "lib" / "shaders" / "colormapShaders.ts"
OUT_DIR = ROOT / "public" / "static" / "colormaps"

SWATCH_W = 256
SWATCH_H = 16

# ---------------------------------------------------------------------------
# Parse polynomial coefficients from the TypeScript / GLSL source
# ---------------------------------------------------------------------------


def parse_colormaps(src: str) -> dict[str, list[list[float]]]:
    """Return {name: [[r0,g0,b0], [r1,g1,b1], ..., [r6,g6,b6]]}"""
    colormaps: dict[str, list[list[float]]] = {}

    # Match every 'vec3 <name>(float t) { ... }' block
    func_re = re.compile(r"vec3\s+(\w+)\s*\(float\s+t\)\s*\{([^}]+)\}", re.DOTALL)
    # Match 'const vec3 coeffsN = vec3(r, g, b);'
    coeff_re = re.compile(
        r"const\s+vec3\s+coeffs\d+\s*=\s*vec3\s*\(\s*"
        r"([+-]?\d+\.?\d*(?:e[+-]?\d+)?)\s*,\s*"
        r"([+-]?\d+\.?\d*(?:e[+-]?\d+)?)\s*,\s*"
        r"([+-]?\d+\.?\d*(?:e[+-]?\d+)?)\s*\)"
    )

    for m in func_re.finditer(src):
        name = m.group(1)
        body = m.group(2)
        coeffs = [[float(c) for c in cm.groups()] for cm in coeff_re.finditer(body)]
        if len(coeffs) == 7:
            colormaps[name] = coeffs

    return colormaps


# ---------------------------------------------------------------------------
# Evaluate polynomial (Horner's method, matches GLSL exactly)
# ---------------------------------------------------------------------------


def eval_colormap(coeffs: list[list[float]], t: float) -> tuple[int, int, int]:
    c = coeffs
    r = c[0][0] + t * (
        c[1][0]
        + t * (c[2][0] + t * (c[3][0] + t * (c[4][0] + t * (c[5][0] + t * c[6][0]))))
    )
    g = c[0][1] + t * (
        c[1][1]
        + t * (c[2][1] + t * (c[3][1] + t * (c[4][1] + t * (c[5][1] + t * c[6][1]))))
    )
    b = c[0][2] + t * (
        c[1][2]
        + t * (c[2][2] + t * (c[3][2] + t * (c[4][2] + t * (c[5][2] + t * c[6][2]))))
    )
    # clamp to [0, 1] and convert to uint8  (matches GLSL clamp)
    ri = max(0, min(255, round(r * 255)))
    gi = max(0, min(255, round(g * 255)))
    bi = max(0, min(255, round(b * 255)))
    return (ri, gi, bi)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    src = SHADER_SRC.read_text()
    colormaps = parse_colormaps(src)

    if not colormaps:
        sys.exit(f"No colormap functions found in {SHADER_SRC}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for name, coeffs in sorted(colormaps.items()):
        img = Image.new("RGB", (SWATCH_W, SWATCH_H))
        pixels = img.load()
        for x in range(SWATCH_W):
            t = x / (SWATCH_W - 1)
            color = eval_colormap(coeffs, t)
            for y in range(SWATCH_H):
                pixels[x, y] = color  # type: ignore[index]

        out_path = OUT_DIR / f"{name}.webp"
        img.save(out_path, "WEBP", lossless=True, quality=100)

    print(f"Generated {len(colormaps)} swatches → {OUT_DIR}")


if __name__ == "__main__":
    main()
