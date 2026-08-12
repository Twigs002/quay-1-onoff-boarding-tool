"""
photo_pipeline.py - build a branded profile photo for a FULL-STATUS agent.

Flow: take the agent's headshot -> remove the background (rembg) -> composite the
cut-out onto the solid Quay 1 navy (#3D5BA6) circular backdrop
(assets/p24_backdrop_blue.png) -> clip to the template circle -> save a 1080x1080
PNG. The PropData worker then uploads that PNG as the profile picture.

Candidate / blank-status agents do NOT go through this pipeline: they keep the plain
Quay 1 logo (config.PROPDATA_DEFAULT_PHOTO = assets/quay1_profile.png). Only full-FFC
agents get a personalised photo (mirrors _designation_for in provisioners/propdata.py).

rembg is imported LAZILY (heavy: onnxruntime + a ~176 MB model downloaded on first
run) so the rest of the worker never pays for it unless a photo is actually built.

CLI (for tuning against a real headshot):
    python worker/photo_pipeline.py <headshot.jpg> [out.png]
"""
from __future__ import annotations

import pathlib

try:
    from PIL import Image
except ImportError:  # Pillow is a hard dep of this module only
    Image = None

ASSETS = pathlib.Path(__file__).resolve().parent / "assets"
DEFAULT_BACKDROP = ASSETS / "p24_backdrop_blue.png"   # solid Quay 1 navy circle

# Composition geometry as fractions of the canvas, calibrated against a real finished
# P24 photo ("P24 - WARREN.png": person ~85% canvas height, head-top ~14.6%, bottom-
# anchored, centred). Override per-call when fine-tuning.
CUTOUT_HEIGHT_FRAC = 0.86    # cut-out height as a fraction of the canvas height
CUTOUT_BOTTOM_FRAC = 1.00    # where the BOTTOM of the cut-out sits (1.0 = canvas bottom edge)


def _load_rembg():
    """Import rembg lazily and return its remove() + a people-tuned session (or None)."""
    from rembg import remove, new_session
    try:
        session = new_session("u2net_human_seg")   # segmentation model tuned for people
    except Exception:
        session = None                              # fall back to rembg's default u2net
    return remove, session


def remove_background(img: "Image.Image") -> "Image.Image":
    """Return `img` with its background removed, as an RGBA cut-out."""
    remove, session = _load_rembg()
    out = remove(img, session=session) if session else remove(img)
    return out.convert("RGBA")


def _trim_alpha(img: "Image.Image") -> "Image.Image":
    """Crop transparent margins so the person fills the cut-out's bounding box."""
    bbox = img.split()[3].getbbox()
    return img.crop(bbox) if bbox else img


def _default_out(source_path) -> str:
    p = pathlib.Path(source_path)
    return str(p.with_name(p.stem + "_p24.png"))


def build_profile_photo(source_path, out_path=None, backdrop_path=None,
                       cutout_height_frac: float = CUTOUT_HEIGHT_FRAC,
                       cutout_bottom_frac: float = CUTOUT_BOTTOM_FRAC) -> str:
    """Build the branded circular profile photo and write it to `out_path`.

    Returns the output path. The template circle is taken from the backdrop's own
    alpha channel, so the final image is clipped to exactly the Canva circle (no
    hardcoded geometry) and anything the person overflows past the circle is trimmed.
    """
    if Image is None:
        raise RuntimeError("Pillow is required for the photo pipeline: pip install Pillow")

    backdrop = Image.open(backdrop_path or DEFAULT_BACKDROP).convert("RGBA")
    W, H = backdrop.size
    circle_mask = backdrop.split()[3]               # opaque circle = the template shape

    src = Image.open(source_path).convert("RGBA")
    cut = _trim_alpha(remove_background(src))

    # Scale the cut-out to the target height (keep aspect), centre-x, bottom-anchored.
    target_h = max(1, int(H * cutout_height_frac))
    scale = target_h / cut.height
    target_w = max(1, int(cut.width * scale))
    cut = cut.resize((target_w, target_h), Image.LANCZOS)

    x = (W - target_w) // 2
    y = int(H * cutout_bottom_frac) - target_h

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.alpha_composite(cut, (x, y))
    comp = Image.alpha_composite(backdrop, layer)
    comp.putalpha(circle_mask)                       # clip the whole composite to the circle

    out = str(out_path or _default_out(source_path))
    comp.save(out)
    return out


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: python photo_pipeline.py <headshot> [out.png]")
        raise SystemExit(2)
    written = build_profile_photo(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    print("wrote", written)
