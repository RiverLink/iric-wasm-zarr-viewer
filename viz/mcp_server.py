"""MCP server exposing the iRIC result viewer / analysis features (stdio transport).

Register with Claude Code (project scope, .mcp.json is provided in the workspace root) or run:
    claude mcp add iric -- python <this dir>/mcp_server.py
Claude Desktop: add to claude_desktop_config.json
    {"mcpServers": {"iric": {"command": "python", "args": ["<this dir>/mcp_server.py"]}}}

Coordinates: i, j are 1-based grid indices (iRIC convention). Steps are 0-based; negative counts from
the end (-1 = last). Variables accept the safe key ("Depth", "WaterSurfaceElevation", "Velocity_ms_1_X")
or the original iRIC name ("Velocity(ms-1)X").
"""
import os, sys, json, subprocess, time, urllib.request, webbrowser
from typing import Optional
import numpy as np
from mcp.server.fastmcp import FastMCP, Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import convert, report, analysis, render               # noqa: E402
from analysis import Project, to_list                  # noqa: E402

mcp = FastMCP("iric-results", log_level="WARNING", instructions=(
    "Tools for browsing, converting, analysing, comparing and reporting iRIC (Nays2D Flood etc.) simulation "
    "results. Typical flow: list_projects -> convert_project (if not converted) -> project_info / analyze / "
    "compare / render_* / make_report. i,j are 1-based; steps are 0-based (negative = from the end)."))

VIEWER_PORT = 8765


def _projects(names):
    if isinstance(names, str): names = [n.strip() for n in names.split(",") if n.strip()]
    if not names: raise ValueError("at least one project name is required")
    return [Project.open(n) for n in names]


PREVIEW_MAX_PX = int(os.environ.get("IRIC_MCP_PREVIEW_PX", "1000"))   # width of the JPEG preview sent to the model


def _preview(path):
    """Downscaled JPEG of a rendered PNG so the image returned to the model stays small (~100 KB)."""
    from PIL import Image as PILImage
    import io
    im = PILImage.open(path).convert("RGB")
    if im.width > PREVIEW_MAX_PX: im = im.resize((PREVIEW_MAX_PX, int(im.height * PREVIEW_MAX_PX / im.width)), PILImage.LANCZOS)
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=80, optimize=True)
    return Image(data=buf.getvalue(), format="jpeg")


def _img(path, text):
    return [text, _preview(path)]


def _line(p, i, j, mode):
    r, c = p.node(i, j)
    return [(rr, c) for rr in range(p.nj)] if mode == "xs" else [(r, cc) for cc in range(p.ni)]


# ---------------------------------------------------------------- discovery / conversion
@mcp.tool()
def list_projects(folder: str) -> dict:
    """List iRIC projects (*.ipro files or folders containing project.xml) in a folder, with solver, CRS,
    size and whether a converted Zarr cache already exists."""
    import server
    return {"folder": os.path.abspath(folder), "projects": server.scan_folder(folder)}


@mcp.tool()
def convert_project(path: str) -> dict:
    """Convert one iRIC project (.ipro, project folder, or .cgn) into the Zarr cache so the other tools can
    use it. Returns the project name and metadata. Skipped when the cache is up to date."""
    import server
    r = server.do_convert(path)
    Project._cache.pop(r["name"], None)
    meta = r["meta"]
    return {"name": r["name"], "cached": r["cached"], "ni": meta.get("ni"), "nj": meta.get("nj"), "nt": meta.get("nt"), "crs": meta.get("crs"), "solver": meta.get("solver"), "variables": list(meta.get("variables", {}).values())}


@mcp.tool()
def project_info(name: str) -> dict:
    """Grid size, steps, time range, CRS, centre lon/lat, total area and available variables (with global
    min/max) of a converted project."""
    return Project.open(name).info()


# ---------------------------------------------------------------- single-project data
@mcp.tool()
def field_stats(name: str, variable: str = "Depth", step: int = -1, threshold: float = 0.01) -> dict:
    """Statistics of a variable at one step: min / max / mean over wet nodes, wet node count, wet area and
    stored volume (depth > threshold). Also returns the location (i, j) of the maximum."""
    p = Project.open(name); t = p.step(step); key = p.key(variable)
    v = p.get(key, t); d = p.get("Depth", t)
    wet = d > threshold
    ws = p.wet_stats(d, threshold, p.get("Velocity_ms_1_X", t) if "Velocity_ms_1_X" in p.variables else None, p.get("Velocity_ms_1_Y", t) if "Velocity_ms_1_Y" in p.variables else None)
    vv = v[wet]
    k = int(np.nanargmax(np.where(wet, v, -np.inf))) if wet.any() else None
    return {"project": name, "variable": key, "label": p.label(key), "unit": p.unit(key), "step": t, "time_s": float(p.time[t]),
            "min_wet": float(vv.min()) if vv.size else None, "max_wet": float(vv.max()) if vv.size else None, "mean_wet": float(vv.mean()) if vv.size else None,
            "max_at": {"i": k % p.ni + 1, "j": k // p.ni + 1} if k is not None else None, **ws}


@mcp.tool()
def point_timeseries(name: str, i: int, j: int, variables: str = "Depth") -> dict:
    """Time series of one or more variables (comma separated) at grid node (i, j)."""
    p = Project.open(name)
    keys = [p.key(v.strip()) for v in variables.split(",") if v.strip()]
    out = {"project": name, "i": i, "j": j, "x": float(p.x[p.node(i, j)]), "y": float(p.y[p.node(i, j)]), "time_s": p.time.tolist()}
    for k in keys:
        y = p.timeseries(k, i, j); pk = int(np.nanargmax(y))
        out[k] = {"unit": p.unit(k), "values": to_list(y), "max": float(y[pk]), "max_time_s": float(p.time[pk])}
    return out


@mcp.tool()
def section(name: str, i: int, j: int, mode: str = "xs", step: int = -1, variable: Optional[str] = None, threshold: float = 0.01) -> dict:
    """Bed elevation and water surface along a grid line through node (i, j) at one step.
    mode 'xs' = cross section (fixed i, along j), 'ls' = longitudinal (fixed j, along i).
    Optionally adds another variable's profile. Water surface is null on dry nodes."""
    p = Project.open(name)
    s = p.section(i, j, mode, step, extra=variable, thr=threshold)
    return {"project": name, **{k: (to_list(v) if isinstance(v, np.ndarray) else v) for k, v in s.items()}}


@mcp.tool()
def analyze(name: str, threshold: float = 0.01, series_stride: int = 5) -> dict:
    """Whole-run flood analysis: summary (peak wet area and its time, final area, peak volume, max depth /
    speed, ever-wet nodes, median arrival) plus time series (every `series_stride` steps) of wet area,
    volume, max depth and max speed. Arrival-time / duration maps are available via render_map with
    variable '__arrival' or '__duration'."""
    p = Project.open(name); a = p.analyze(threshold)
    st = max(1, int(series_stride))
    ser = {k: (v[::st] if isinstance(v, list) else v) for k, v in a["series"].items()}
    return {"project": name, "summary": a["summary"], "series": ser, "total_area_m2": float(p.total_area())}


# ---------------------------------------------------------------- multi-project
@mcp.tool()
def compare(names: str, variable: str = "Depth", step: int = -1, threshold: float = 0.01) -> dict:
    """Compare several projects (comma separated names): per-case whole-run summaries, per-case field
    statistics at the step, and pairwise differences (each case minus the first) with mean / RMS / max
    absolute difference and the overlap (IoU) of the wet areas. Requires converted projects."""
    P = _projects(names); ref = P[0]; sg = analysis.same_grid(P)
    cases = []
    for p in P:
        a = p.analyze(threshold)["summary"]; t = p.step(step)
        d = p.get("Depth", t)
        ws = p.wet_stats(d, threshold, p.get("Velocity_ms_1_X", t) if "Velocity_ms_1_X" in p.variables else None, p.get("Velocity_ms_1_Y", t) if "Velocity_ms_1_Y" in p.variables else None)
        cases.append({"name": p.name, "summary": a, "at_step": {"step": t, "time_s": float(p.time[t]), **ws}})
    out = {"variable": ref.key(variable), "same_grid": sg, "cases": cases}
    if sg:
        out["differences_vs_first"] = [analysis.diff_field(p, ref, variable, step, threshold)["stats"] | {"case": p.name, "reference": ref.name} for p in P[1:]]
    a0 = cases[0]["summary"]
    out["ratios_vs_first"] = [{"case": c["name"], "peak_wet_area": c["summary"]["peak_wet_area_m2"] / a0["peak_wet_area_m2"] if a0["peak_wet_area_m2"] else None,
                               "peak_volume": c["summary"]["peak_volume_m3"] / a0["peak_volume_m3"] if a0["peak_volume_m3"] else None,
                               "max_depth": c["summary"]["max_depth_m"] / a0["max_depth_m"] if a0["max_depth_m"] else None} for c in cases[1:]]
    return out


@mcp.tool()
def ensemble(names: str, metric: str = "freq", threshold: float = 0.01) -> dict:
    """Integrated (ensemble) statistics over several same-grid projects. metric: 'freq' (fraction of cases in
    which each node floods), 'envmax' (envelope of maximum depth), 'envmin', 'arrmin' (earliest arrival,
    min), 'arrspread' (latest - earliest arrival). Use render_ensemble_map for the picture."""
    P = _projects(names)
    if not analysis.same_grid(P): raise ValueError("ensemble statistics need projects on the same grid")
    return analysis.ensemble_field(P, metric, threshold)["stats"]


# ---------------------------------------------------------------- images
@mcp.tool()
def render_map(name: str, variable: str = "Depth", step: int = -1, basemap: str = "gsi_pale", cmap: Optional[str] = None,
               vmin: Optional[float] = None, vmax: Optional[float] = None, threshold: float = 0.01, hide_dry: bool = True,
               probe_i: Optional[int] = None, probe_j: Optional[int] = None, section_mode: Optional[str] = None, out_path: Optional[str] = None) -> list:
    """Render a variable at one step as a PNG map over a basemap ('gsi_pale', 'gsi_std', 'gsi_photo', 'gsi_hill',
    'osm' or 'none'). Special variables after analyze(): '__arrival' (minutes), '__duration' (minutes).
    Optional probe (i, j) marker and section line ('xs' / 'ls'). Returns the file path and the image."""
    p = Project.open(name); t = p.step(step)
    if variable in ("__arrival", "__duration"):
        a = p.analyze(threshold); v = a["arrival_min"] if variable == "__arrival" else a["duration_min"]
        label, unit, mask = ("到達時間" if variable == "__arrival" else "浸水継続時間"), "min", None
        cmap = cmap or ("turbo" if variable == "__arrival" else "viridis")
    else:
        key = p.key(variable); v = p.get(key, t); label, unit = p.label(key), p.unit(key)
        mask = (p.get("Depth", t) <= threshold) if (hide_dry and "Depth" in p.variables) else None
        if vmin is None or vmax is None: r = p.range(key); vmin = r[0] if vmin is None else vmin; vmax = r[1] if vmax is None else vmax
        cmap = cmap or ("blues" if key == "Depth" else "viridis")
    line = _line(p, probe_i, probe_j, section_mode) if (probe_i and probe_j and section_mode) else None
    probe = p.node(probe_i, probe_j) if (probe_i and probe_j) else None
    path = render.out_path(out_path, f"{analysis.safe(name)}_{analysis.safe(variable)}_t{t}.png")
    render.map_png(p, v, path, title=f"{name}  {label}  t = {p.time[t]:g} s", cmap=cmap, vmin=vmin, vmax=vmax, unit=f"{label} [{unit}]", basemap=basemap, mask=mask, line=line, probe=probe)
    return _img(path, f"saved {path}")


@mcp.tool()
def render_diff_map(name_a: str, name_b: str, variable: str = "Depth", step: int = -1, basemap: str = "gsi_pale", threshold: float = 0.01, out_path: Optional[str] = None) -> list:
    """Render A - B of a variable at one step (diverging colours, red = A larger) with difference statistics."""
    A, B = Project.open(name_a), Project.open(name_b)
    if not analysis.same_grid([A, B]): raise ValueError("difference maps need the same grid")
    D = analysis.diff_field(A, B, variable, step, threshold); s = D["stats"]; lim = s["max_abs_diff"] or 1.0
    path = render.out_path(out_path, f"diff_{analysis.safe(name_a)}_minus_{analysis.safe(name_b)}_{analysis.safe(variable)}_t{s['step']}.png")
    render.map_png(A, np.where(D["mask"], D["diff"], np.nan), path, title=f"{name_a} − {name_b}  Δ{A.label(A.key(variable))}  t = {s['time_s']:g} s", cmap="rdbu", vmin=-lim, vmax=lim, unit=f"Δ [{A.unit(A.key(variable))}]", basemap=basemap,
                   extra_text=f"mean {s['mean_diff']:.3f}  RMS {s['rms_diff']:.3f}  max|Δ| {s['max_abs_diff']:.3f}\nwet IoU {100 * s['wet_iou']:.1f} %")
    return [f"saved {path}", json.dumps(s, ensure_ascii=False), _preview(path)]


@mcp.tool()
def render_ensemble_map(names: str, metric: str = "freq", basemap: str = "gsi_pale", threshold: float = 0.01, out_path: Optional[str] = None) -> list:
    """Render an ensemble map over several same-grid projects (see `ensemble` for metrics)."""
    P = _projects(names)
    if not analysis.same_grid(P): raise ValueError("ensemble maps need projects on the same grid")
    E = analysis.ensemble_field(P, metric, threshold); s = E["stats"]
    path = render.out_path(out_path, f"ensemble_{metric}_{len(P)}cases.png")
    cm = {"freq": "turbo", "envmax": "blues", "envmin": "blues", "arrmin": "turbo", "arrspread": "turbo"}[metric]
    render.map_png(P[0], E["field"], path, title=f"{s['label']}（{len(P)} ケース）", cmap=cm, vmin=0 if metric == "freq" else s["min"], vmax=1 if metric == "freq" else s["max"], unit=f"{s['label']} [{s['unit']}]", basemap=basemap)
    return [f"saved {path}", json.dumps(s, ensure_ascii=False), _preview(path)]


@mcp.tool()
def render_timeseries(names: str, i: int, j: int, variable: str = "Depth", out_path: Optional[str] = None) -> list:
    """Plot the time series of a variable at node (i, j) for one or more projects (overlaid)."""
    P = _projects(names); key = P[0].key(variable)
    series = [{"name": p.name, "y": p.timeseries(key, i, j)} for p in P]
    path = render.out_path(out_path, f"timeseries_{analysis.safe(key)}_i{i}_j{j}.png")
    render.timeseries_png(path, P[0].time, series, title=f"{P[0].label(key)} at (i={i}, j={j})", ylabel=f"{P[0].label(key)} [{P[0].unit(key)}]")
    return _img(path, f"saved {path}")


@mcp.tool()
def render_section(names: str, i: int, j: int, mode: str = "xs", step: int = -1, variable: Optional[str] = "Depth", threshold: float = 0.01, out_path: Optional[str] = None) -> list:
    """Plot bed elevation + water surface (all projects overlaid) along a cross ('xs') or longitudinal ('ls')
    section through node (i, j) at one step, plus an optional second panel for another variable."""
    P = _projects(names)
    secs = [(p.name, p.section(i, j, mode, step, extra=variable, thr=threshold)) for p in P]
    t = secs[0][1]["step"]; key = P[0].key(variable) if variable else None
    path = render.out_path(out_path, f"section_{mode}_i{i}_j{j}_t{t}.png")
    label = f"横断面 i={i}" if mode == "xs" else f"縦断面 j={j}"
    render.section_png(path, secs, title=f"{label}  t = {secs[0][1]['time_s']:g} s", extra_key=key, extra_label=f"{P[0].label(key)} [{P[0].unit(key)}]" if key else "")
    return _img(path, f"saved {path}  (length {secs[0][1]['length_m']:.0f} m)")


@mcp.tool()
def render_stats(names: str, threshold: float = 0.01, out_path: Optional[str] = None) -> list:
    """Plot wet area, volume, max depth and max speed versus time for one or more projects."""
    P = _projects(names)
    cases = [(p.name, p.analyze(threshold)["series"]) for p in P]
    path = render.out_path(out_path, f"stats_{len(P)}cases.png")
    render.stats_png(path, cases)
    return _img(path, f"saved {path}")


# ---------------------------------------------------------------- report
@mcp.tool()
def make_report(names: str, variable: str = "Depth", step: int = -1, threshold: float = 0.01, basemap: str = "gsi_pale",
                probe_i: Optional[int] = None, probe_j: Optional[int] = None, section_mode: Optional[str] = None,
                title: Optional[str] = None, out_path: Optional[str] = None) -> dict:
    """Build a PPTX report. One project: overview, map, whole-run statistics (chart + table), arrival / duration
    maps, optional point time series and section. Several projects: case table, side-by-side maps, difference
    maps vs the first case, ensemble maps, statistics comparison (chart + table), optional point / section
    comparison. Returns the file path and the slide list."""
    P = _projects(names); ref = P[0]; t = ref.step(step); key = ref.key(variable)
    tmp = os.path.join(render.OUT, "report_tmp"); os.makedirs(tmp, exist_ok=True)
    img = lambda fn: render.png_data_url(os.path.join(tmp, fn), jpeg=not fn.startswith(("stats", "point", "section")))
    line = _line(ref, probe_i, probe_j, section_mode) if (probe_i and probe_j and section_mode) else None
    probe = ref.node(probe_i, probe_j) if (probe_i and probe_j) else None
    sections = []
    ana = {p.name: p.analyze(threshold) for p in P}
    for p in P:
        a = ana[p.name]; S = a["summary"]
        r = p.range(key)
        render.map_png(p, p.get(key, t), os.path.join(tmp, f"map_{p.name}.png"), title=f"{p.name}  {p.label(key)}  t = {p.time[t]:g} s", cmap="blues" if key == "Depth" else "viridis", vmin=r[0], vmax=r[1], unit=f"{p.label(key)} [{p.unit(key)}]", basemap=basemap, mask=p.get("Depth", t) <= threshold, line=line, probe=probe)
    if len(P) == 1:
        p = P[0]; S = ana[p.name]["summary"]
        sections.append({"title": "計算ケースの概要", "bullets": [f"プロジェクト: {p.name}", f"ソルバー: {p.A.get('solver', '-')} {p.A.get('solverVersion', '')}", f"格子: {p.ni} × {p.nj} 節点", f"出力ステップ: {p.nt}（t = {p.time[0]:g} – {p.time[-1]:g} s）", f"座標系: {p.A.get('crs') or '不明'}", f"領域面積: {p.total_area() / 1e6:.3f} km²"],
                         "images": [{"dataUrl": img(f"map_{p.name}.png"), "caption": f"{p.label(key)}  t = {p.time[t]:g} s"}]})
        render.stats_png(os.path.join(tmp, "stats.png"), [(p.name, ana[p.name]["series"])], marker_s=float(p.time[t]))
        sections.append({"title": "全ステップ解析（浸水面積・貯留量・最大水深・最大流速）", "images": [{"dataUrl": img("stats.png")}],
                         "bullets": [f"湿潤判定閾値: 水深 > {threshold} m", f"浸水面積 最大 {S['peak_wet_area_m2'] / 1e6:.3f} km²（領域の {100 * S['peak_wet_area_fraction']:.1f} %）@ t = {S['peak_wet_area_time_s']:g} s", f"最終ステップの浸水面積 {S['final_wet_area_m2'] / 1e6:.3f} km²", f"貯留量 最大 {S['peak_volume_m3'] / 1e3:.1f} ×10³ m³", f"最大水深 {S['max_depth_m']:.2f} m" + (f" / 最大流速 {S['max_speed_ms']:.2f} m/s" if S['max_speed_ms'] is not None else "")],
                         "table": {"header": ["指標", "値"], "rows": [["浸水面積 最大 [km²]", f"{S['peak_wet_area_m2'] / 1e6:.3f}"], ["最大時刻 [s]", f"{S['peak_wet_area_time_s']:g}"], ["最終浸水面積 [km²]", f"{S['final_wet_area_m2'] / 1e6:.3f}"], ["貯留量 最大 [m³]", f"{S['peak_volume_m3']:.0f}"], ["最大水深 [m]", f"{S['max_depth_m']:.3f}"], ["最大流速 [m/s]", f"{S['max_speed_ms']:.3f}" if S['max_speed_ms'] is not None else "-"], ["浸水を経験した節点数", f"{S['ever_wet_nodes']} / {S['total_nodes']}"]]}})
        a = ana[p.name]
        render.map_png(p, a["arrival_min"], os.path.join(tmp, "arrival.png"), title="到達時間 [min]", cmap="turbo", unit="min", basemap=basemap)
        render.map_png(p, a["duration_min"], os.path.join(tmp, "duration.png"), title="浸水継続時間 [min]", cmap="viridis", unit="min", basemap=basemap)
        sections.append({"title": "到達時間・浸水継続時間", "images": [{"dataUrl": img("arrival.png"), "caption": "到達時間 [min]"}, {"dataUrl": img("duration.png"), "caption": "浸水継続時間 [min]"}], "bullets": [f"到達時間: 水深が初めて {threshold} m を超えた時刻", f"浸水継続時間: 水深 > {threshold} m であった時間の合計"]})
    else:
        sg = analysis.same_grid(P)
        sections.append({"title": "比較対象の計算ケース", "table": {"header": ["ケース", "ソルバー", "格子", "ステップ", "座標系", "領域面積 [km²]"], "rows": [[p.name, f"{p.A.get('solver', '')} {p.A.get('solverVersion', '')}", f"{p.ni}×{p.nj}", p.nt, p.A.get("crs") or "-", f"{p.total_area() / 1e6:.3f}"] for p in P]},
                         "bullets": [f"比較変数: {ref.label(key)}", f"表示時刻: t = {ref.time[t]:g} s", f"湿潤判定閾値: 水深 > {threshold} m", "全ケースが同一格子（節点単位で比較可能）" if sg else "格子が異なるため統計比較のみ"]})
        sections.append({"title": f"並列表示: {ref.label(key)}", "images": [{"dataUrl": img(f"map_{p.name}.png"), "caption": f"{p.name}  t = {ref.time[t]:g} s"} for p in P]})
        if sg:
            dimgs, dbul = [], []
            for p in P[1:]:
                D = analysis.diff_field(p, ref, key, t, threshold); s = D["stats"]; lim = s["max_abs_diff"] or 1.0
                fn = f"diff_{p.name}.png"
                render.map_png(p, np.where(D["mask"], D["diff"], np.nan), os.path.join(tmp, fn), title=f"{p.name} − {ref.name}", cmap="rdbu", vmin=-lim, vmax=lim, unit=f"Δ{ref.label(key)} [{ref.unit(key)}]", basemap=basemap)
                dimgs.append({"dataUrl": img(fn), "caption": f"{p.name} − {ref.name}  (±{lim:.3g} {ref.unit(key)})"})
                dbul.append(f"{p.name} − {ref.name}: 平均差 {s['mean_diff']:.3f}, RMS {s['rms_diff']:.3f}, 最大|差| {s['max_abs_diff']:.3f} {ref.unit(key)}, 湿潤範囲の一致率 {100 * s['wet_iou']:.1f} %")
            sections.append({"title": f"差分マップ: {ref.label(key)}  t = {ref.time[t]:g} s（赤: 対象ケースが大きい）", "images": dimgs, "bullets": dbul})
            eimgs = []
            for m in ["freq", "envmax", "arrmin", "arrspread"]:
                E = analysis.ensemble_field(P, m, threshold); s = E["stats"]; fn = f"ens_{m}.png"
                render.map_png(ref, E["field"], os.path.join(tmp, fn), title=s["label"], cmap="turbo" if m != "envmax" else "blues", vmin=0 if m == "freq" else s["min"], vmax=1 if m == "freq" else s["max"], unit=f"[{s['unit']}]", basemap=basemap)
                eimgs.append({"dataUrl": img(fn), "caption": f"{s['label']} [{s['unit']}]"})
            fs = analysis.ensemble_field(P, "freq", threshold)["stats"]
            sections.append({"title": "統合解析（全ケースの重ね合わせ）", "images": eimgs, "bullets": [f"全ケースで浸水 {fs['nodes_wet_in_all_cases']} 節点 / いずれかで浸水 {fs['nodes_wet_in_any_case']} 節点 / 全 {fs['total_nodes']} 節点"]})
        render.stats_png(os.path.join(tmp, "stats.png"), [(p.name, ana[p.name]["series"]) for p in P], marker_s=float(ref.time[t]))
        rows = [[p.name, f"{ana[p.name]['summary']['peak_wet_area_m2'] / 1e6:.3f}", f"{ana[p.name]['summary']['peak_wet_area_time_s']:g}", f"{100 * ana[p.name]['summary']['peak_wet_area_fraction']:.1f}", f"{ana[p.name]['summary']['final_wet_area_m2'] / 1e6:.3f}", f"{ana[p.name]['summary']['peak_volume_m3'] / 1e3:.1f}", f"{ana[p.name]['summary']['max_depth_m']:.3f}", f"{ana[p.name]['summary']['max_speed_ms']:.3f}" if ana[p.name]['summary']['max_speed_ms'] is not None else "-", str(ana[p.name]['summary']['ever_wet_nodes'])] for p in P]
        sections.append({"title": "統計比較（浸水面積・貯留量・最大水深・最大流速）", "images": [{"dataUrl": img("stats.png")}], "table": {"header": ["ケース", "浸水面積 最大 [km²]", "最大時刻 [s]", "領域比 [%]", "最終浸水面積 [km²]", "貯留量 最大 [10³ m³]", "最大水深 [m]", "最大流速 [m/s]", "浸水節点数"], "rows": rows}})
    if probe_i and probe_j:
        render.timeseries_png(os.path.join(tmp, "point.png"), ref.time, [{"name": p.name, "y": p.timeseries(key, probe_i, probe_j)} for p in P], title=f"{ref.label(key)} at (i={probe_i}, j={probe_j})", ylabel=f"[{ref.unit(key)}]", marker_s=float(ref.time[t]))
        sections.append({"title": f"地点時系列 (i={probe_i}, j={probe_j})", "images": [{"dataUrl": img("point.png")}]})
        if section_mode:
            secs = [(p.name, p.section(probe_i, probe_j, section_mode, t, extra=key, thr=threshold)) for p in P]
            render.section_png(os.path.join(tmp, "section.png"), secs, title=("横断面 i=%d" % probe_i if section_mode == "xs" else "縦断面 j=%d" % probe_j) + f"  t = {ref.time[t]:g} s", extra_key=key, extra_label=f"{ref.label(key)} [{ref.unit(key)}]")
            sections.append({"title": "断面" + ("比較" if len(P) > 1 else ""), "images": [{"dataUrl": img("section.png")}], "bullets": [f"断面長 {secs[0][1]['length_m']:.0f} m"]})
    ttl = title or (f"iRIC 計算結果レポート: {ref.name}" if len(P) == 1 else "iRIC 計算結果 比較レポート")
    path = render.out_path(out_path, ("report_%s.pptx" % analysis.safe(ref.name)) if len(P) == 1 else "compare_report_%s.pptx" % time.strftime("%Y%m%d_%H%M%S"))
    report.build_pptx({"title": ttl, "subtitle": " / ".join(p.name for p in P) + "\n作成日 " + time.strftime("%Y-%m-%d"), "sections": sections}, path)
    return {"path": path, "slides": ["title"] + [s["title"] for s in sections], "size_bytes": os.path.getsize(path)}


# ---------------------------------------------------------------- web viewer
@mcp.tool()
def open_viewer(names: str = "", folder: str = "", open_browser: bool = True) -> dict:
    """Start the interactive web viewer (server.py) if it is not running and return the URL that opens the
    given projects (one name = single viewer, several = comparison dashboard)."""
    url = f"http://127.0.0.1:{VIEWER_PORT}/"
    running = False
    try:
        urllib.request.urlopen(url, timeout=2); running = True
    except Exception:
        subprocess.Popen([sys.executable, os.path.join(HERE, "server.py"), str(VIEWER_PORT)], cwd=HERE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        for _ in range(20):
            time.sleep(0.5)
            try: urllib.request.urlopen(url, timeout=2); running = True; break
            except Exception: pass
    q = []
    if folder: q.append("folder=" + urllib.request.quote(os.path.abspath(folder)))
    if names: q.append("open=" + urllib.request.quote(",".join(n.strip() for n in names.split(","))))
    full = url + ("?" + "&".join(q) if q else "")
    if open_browser and running: webbrowser.open(full)
    return {"url": full, "server_running": running}


if __name__ == "__main__":
    mcp.run()
