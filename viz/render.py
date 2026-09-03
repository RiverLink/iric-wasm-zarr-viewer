"""Matplotlib rendering of maps (with optional GSI / OSM basemap tiles) and charts to PNG files."""
import os, io, math, base64, urllib.request
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from PIL import Image as PILImage

HERE = os.path.dirname(os.path.abspath(__file__))
TILE_CACHE = os.path.join(HERE, "cache", "tiles")
OUT = os.path.join(HERE, "out")
MAXM = 20037508.342789244
BASEMAPS = {
    "gsi_pale": ("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", 5, 18, "地理院タイル（淡色地図）"),
    "gsi_std": ("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", 5, 18, "地理院タイル（標準地図）"),
    "gsi_photo": ("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", 2, 18, "地理院タイル（全国最新写真）"),
    "gsi_hill": ("https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png", 2, 16, "地理院タイル（陰影起伏図）"),
    "osm": ("https://tile.openstreetmap.org/{z}/{x}/{y}.png", 0, 19, "© OpenStreetMap contributors"),
}
CMAPS = {"viridis": "viridis", "turbo": "turbo", "jet": "jet", "blues": "Blues", "terrain": "terrain", "rdbu": "RdBu_r"}
PALETTE = ["#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#ff7f0e", "#17becf", "#8c564b", "#e377c2"]

# Japanese-capable font if available
for name in ("Yu Gothic", "Meiryo", "MS Gothic", "Noto Sans CJK JP", "IPAexGothic"):
    if any(f.name == name for f in font_manager.fontManager.ttflist):
        plt.rcParams["font.family"] = name; break
plt.rcParams["axes.unicode_minus"] = False


def out_path(path, default):
    if path:
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True); return os.path.abspath(path)
    os.makedirs(OUT, exist_ok=True); return os.path.join(OUT, default)


# ---------------------------------------------------------------- tiles
def _tile(src, z, x, y):
    url, zmin, zmax, _ = BASEMAPS[src]
    n = 2 ** z; x %= n
    if not 0 <= y < n: return None
    os.makedirs(os.path.join(TILE_CACHE, src, str(z)), exist_ok=True)
    fn = os.path.join(TILE_CACHE, src, str(z), f"{x}_{y}.png")
    if not os.path.exists(fn):
        req = urllib.request.Request(url.format(z=z, x=x, y=y), headers={"User-Agent": "iric-wasm-zarr-viewer/1.0 (mcp)"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r: data = r.read()
        except Exception:
            return None
        PILImage.open(io.BytesIO(data)).convert("RGB").save(fn)
    return PILImage.open(fn).convert("RGB")


def basemap_image(src, west, south, east, north, px_width=1200):
    """Mosaic of tiles covering the Web Mercator bbox. Returns (PIL image, extent)."""
    url, zmin, zmax, attr = BASEMAPS[src]
    res = (east - west) / px_width
    z = int(math.ceil(math.log2(2 * MAXM / (256 * res)))); z = max(zmin, min(zmax, z))
    tm = 2 * MAXM / 2 ** z
    tx0, tx1 = int(math.floor((west + MAXM) / tm)), int(math.floor((east + MAXM) / tm))
    ty0, ty1 = int(math.floor((MAXM - north) / tm)), int(math.floor((MAXM - south) / tm))
    tx1 = min(tx1, tx0 + 12); ty1 = min(ty1, ty0 + 12)
    mosaic = PILImage.new("RGB", (256 * (tx1 - tx0 + 1), 256 * (ty1 - ty0 + 1)), (250, 250, 250))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            im = _tile(src, z, tx, ty)
            if im: mosaic.paste(im, (256 * (tx - tx0), 256 * (ty - ty0)))
    extent = (tx0 * tm - MAXM, (tx1 + 1) * tm - MAXM, MAXM - (ty1 + 1) * tm, MAXM - ty0 * tm)
    return mosaic, extent, attr


# ---------------------------------------------------------------- maps
def map_png(proj, values, path, title="", cmap="blues", vmin=None, vmax=None, unit="", basemap="gsi_pale", mask=None,
            alpha=0.8, line=None, probe=None, size=(11, 7), dpi=110, extra_text=None):
    """values: (nj, ni) node field; NaN = not drawn. mask: boolean (nj, ni) nodes to hide (dry).
    line: list of (row, col) node indices for a section line; probe: (row, col)."""
    v = np.array(values, dtype=np.float64)
    if mask is not None: v = np.where(mask, np.nan, v)
    use_map = basemap and basemap != "none" and proj.has_merc
    X, Y = (proj.mx, proj.my) if use_map else (proj.x, proj.y)
    fig, ax = plt.subplots(figsize=size, dpi=dpi)
    x0, x1, y0, y1 = X.min(), X.max(), Y.min(), Y.max()
    pad = 0.04 * max(x1 - x0, y1 - y0)
    # keep the aspect of the figure: widen the shorter extent
    ax_w, ax_h = size[0] * 0.86, size[1] * 0.9
    w, hgt = (x1 - x0) + 2 * pad, (y1 - y0) + 2 * pad
    if w / hgt < ax_w / ax_h: w = hgt * ax_w / ax_h
    else: hgt = w * ax_h / ax_w
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    west, east, south, north = cx - w / 2, cx + w / 2, cy - hgt / 2, cy + hgt / 2
    attr = None
    if use_map:
        try:
            im, ext, attr = basemap_image(basemap, west, south, east, north, px_width=int(size[0] * dpi))
            ax.imshow(im, extent=ext, origin="upper", interpolation="bilinear", zorder=0)
        except Exception as e:
            attr = f"basemap unavailable: {e}"
    finite = np.isfinite(v)
    if vmin is None: vmin = float(np.nanmin(v)) if finite.any() else 0
    if vmax is None: vmax = float(np.nanmax(v)) if finite.any() else 1
    if vmax <= vmin: vmax = vmin + 1e-6
    pc = ax.pcolormesh(X, Y, np.ma.masked_invalid(v), shading="gouraud", cmap=CMAPS.get(cmap, cmap), vmin=vmin, vmax=vmax, alpha=alpha if use_map else 1.0, zorder=2)
    cb = fig.colorbar(pc, ax=ax, fraction=0.035, pad=0.02); cb.set_label(unit)
    if line:
        rr = [r for r, c in line]; cc = [c for r, c in line]
        ax.plot(X[rr, cc], Y[rr, cc], color="#d0021b", lw=2, zorder=4)
    if probe:
        r, c = probe; ax.plot(X[r, c], Y[r, c], "o", ms=9, mfc="white", mec="#d0021b", mew=2, zorder=5)
    ax.set_xlim(west, east); ax.set_ylim(south, north); ax.set_aspect("equal"); ax.set_xticks([]); ax.set_yticks([])
    ax.set_title(title, fontsize=12, loc="left")
    if attr: ax.text(0.995, 0.005, attr, transform=ax.transAxes, ha="right", va="bottom", fontsize=8, bbox=dict(fc="white", alpha=0.8, ec="none"))
    if extra_text: ax.text(0.005, 0.995, extra_text, transform=ax.transAxes, ha="left", va="top", fontsize=9, family="monospace", bbox=dict(fc="white", alpha=0.85, ec="#d9dce1"))
    fig.tight_layout(); fig.savefig(path); plt.close(fig)
    return path


# ---------------------------------------------------------------- charts
def _finish(fig, path):
    fig.tight_layout(); fig.savefig(path); plt.close(fig); return path


def timeseries_png(path, time_s, series, title="", ylabel="", marker_s=None, size=(11, 4.5), dpi=110):
    """series: list of {name, y, color?}."""
    fig, ax = plt.subplots(figsize=size, dpi=dpi)
    for k, s in enumerate(series):
        ax.plot(time_s, s["y"], color=s.get("color", PALETTE[k % len(PALETTE)]), lw=1.6, label=s["name"])
    if marker_s is not None: ax.axvline(marker_s, color="#d0021b", ls="--", lw=1)
    ax.set_xlabel("t [s]"); ax.set_ylabel(ylabel); ax.set_title(title, loc="left"); ax.grid(alpha=0.3); ax.legend(fontsize=9)
    return _finish(fig, path)


def section_png(path, sections, title="", extra_key=None, extra_label="", size=(12, 5), dpi=110):
    """sections: list of (name, section dict from Project.section). Bed from the first section."""
    two = extra_key is not None and any(extra_key in s for _, s in sections)
    fig, axes = plt.subplots(1, 2 if two else 1, figsize=size, dpi=dpi)
    ax = axes[0] if two else axes
    name0, s0 = sections[0]
    if "elevation_m" in s0:
        ax.fill_between(s0["distance_m"], s0["elevation_m"], s0["elevation_m"].min() - 0.5, color="#8c6d31", alpha=0.25, lw=0)
        ax.plot(s0["distance_m"], s0["elevation_m"], color="#8c6d31", lw=1.5, label="河床標高")
    for k, (name, s) in enumerate(sections):
        if "water_surface_m" in s: ax.plot(s["distance_m"], s["water_surface_m"], color=PALETTE[k % len(PALETTE)], lw=1.6, label=f"{name} 水位")
    ax.axvline(s0["marker_distance_m"], color="#d0021b", ls="--", lw=1)
    ax.set_xlabel("距離 [m]"); ax.set_ylabel("[m]"); ax.set_title(title, loc="left"); ax.grid(alpha=0.3); ax.legend(fontsize=9)
    if two:
        ax2 = axes[1]
        for k, (name, s) in enumerate(sections):
            if extra_key in s: ax2.plot(s["distance_m"], s[extra_key], color=PALETTE[k % len(PALETTE)], lw=1.6, label=name)
        ax2.axvline(s0["marker_distance_m"], color="#d0021b", ls="--", lw=1)
        ax2.set_xlabel("距離 [m]"); ax2.set_title(extra_label, loc="left"); ax2.grid(alpha=0.3); ax2.legend(fontsize=9)
    return _finish(fig, path)


def stats_png(path, cases, marker_s=None, size=(14, 4.2), dpi=110):
    """cases: list of (name, series dict from Project.analyze)."""
    panels = [("wet_area_m2", "浸水面積 [km²]", 1e-6), ("volume_m3", "貯留量 [10³ m³]", 1e-3), ("max_depth_m", "最大水深 [m]", 1), ("max_speed_ms", "最大流速 [m/s]", 1)]
    fig, axes = plt.subplots(1, 4, figsize=size, dpi=dpi)
    for ax, (key, label, f) in zip(axes, panels):
        for k, (name, s) in enumerate(cases):
            if s.get(key) is None: continue
            ax.plot(s["time_s"], np.array(s[key]) * f, color=PALETTE[k % len(PALETTE)], lw=1.5, label=name)
        if marker_s is not None: ax.axvline(marker_s, color="#d0021b", ls="--", lw=1)
        ax.set_title(label, loc="left", fontsize=10); ax.set_xlabel("t [s]"); ax.grid(alpha=0.3)
    axes[0].legend(fontsize=8)
    return _finish(fig, path)


def png_data_url(path, jpeg=True, max_px=1400):
    """Data URL for the report builder; maps are re-encoded as JPEG to keep the pptx small."""
    if not jpeg:
        with open(path, "rb") as f: return "data:image/png;base64," + base64.b64encode(f.read()).decode()
    im = PILImage.open(path).convert("RGB")
    if im.width > max_px: im = im.resize((max_px, int(im.height * max_px / im.width)), PILImage.LANCZOS)
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=85, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
