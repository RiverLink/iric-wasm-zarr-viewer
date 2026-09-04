"""Server-side (numpy) analysis of converted iRIC results — the same definitions as the browser/wasm
kernels, so the MCP tools, the HTTP API and the web viewer agree.

Everything works one time step at a time (StreamAnalyzer) so memory does not depend on the number of
steps: the converter feeds it while streaming a CGNS file, and the API feeds it from the Zarr cache.

Conventions
  * arrays are (nj, ni) node-based, C order; i, j in the public API are 1-based (iRIC style)
  * a cell is wet when the mean of its 4 node depths exceeds `thr`; a node is wet when depth > thr
  * areas / distances use the project CRS coordinates (metres); Web Mercator only for drawing
"""
import os, re, json, math
import numpy as np, zarr

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get("IRIC_CACHE_DIR") or os.path.join(HERE, "cache")


def safe(name):
    return re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_") or "x"


def cache_dir(name):
    return os.path.join(CACHE, safe(name) + ".zarr")


UNITS = {"Depth": "m", "Depth_Max": "m", "Elevation": "m", "WaterSurfaceElevation": "m",
         "Velocity_ms_1_X": "m/s", "Velocity_ms_1_Y": "m/s", "Velocity_magnitude_Max": "m/s"}


def cell_areas(x, y):
    """Planar cell areas (shoelace on the 4 nodes) of a (nj, ni) grid, shape (nj-1, ni-1)."""
    x = np.asarray(x, dtype=np.float64); y = np.asarray(y, dtype=np.float64)
    xa, ya = x[:-1, :-1], y[:-1, :-1]; xb, yb = x[:-1, 1:], y[:-1, 1:]
    xc, yc = x[1:, 1:], y[1:, 1:]; xd, yd = x[1:, :-1], y[1:, :-1]
    return 0.5 * np.abs((xa * yb - xb * ya) + (xb * yc - xc * yb) + (xc * yd - xd * yc) + (xd * ya - xa * yd))


def cell_mean(a):
    return 0.25 * (a[:-1, :-1] + a[:-1, 1:] + a[1:, 1:] + a[1:, :-1])


class StreamAnalyzer:
    """Whole-run flood statistics accumulated one step at a time.
    Call step(t, depth, u, v) for t = 0..nt-1 (u, v may be None), then finish()."""

    def __init__(self, x, y, time, thr=0.01):
        self.area = cell_areas(x, y); self.total_area = float(self.area.sum())
        self.time = np.asarray(time, dtype=np.float64); self.nt = len(self.time); self.thr = float(thr)
        nj, ni = np.asarray(x).shape
        self.arrival = np.full((nj, ni), np.nan, dtype=np.float32)
        self.duration = np.zeros((nj, ni), dtype=np.float32)
        self.dmax = np.zeros((nj, ni), dtype=np.float32)
        self.series = {"time_s": self.time.tolist(), "wet_area_m2": [], "volume_m3": [], "max_depth_m": [], "max_speed_ms": []}
        self.has_vel = False

    def dt(self, t):
        if self.nt < 2: return 0.0
        return float(self.time[t + 1] - self.time[t]) if t + 1 < self.nt else float(self.time[t] - self.time[t - 1])

    def step(self, t, depth, u=None, v=None):
        depth = np.asarray(depth, dtype=np.float32)
        cm = cell_mean(depth); wet = cm > self.thr
        self.series["wet_area_m2"].append(float(self.area[wet].sum()))
        self.series["volume_m3"].append(float((self.area * cm)[wet].sum()))
        nwet = depth > self.thr
        self.series["max_depth_m"].append(float(depth[nwet].max()) if nwet.any() else 0.0)
        if u is not None and v is not None:
            self.has_vel = True
            sp = np.hypot(np.asarray(u, dtype=np.float32), np.asarray(v, dtype=np.float32))
            self.series["max_speed_ms"].append(float(sp[nwet].max()) if nwet.any() else 0.0)
        else:
            self.series["max_speed_ms"].append(None)
        first = nwet & ~np.isfinite(self.arrival)
        self.arrival[first] = self.time[t] / 60.0
        self.duration[nwet] += self.dt(t) / 60.0
        np.maximum(self.dmax, np.where(nwet, depth, 0), out=self.dmax)

    def finish(self):
        a = np.array(self.series["wet_area_m2"]); pk = int(a.argmax()) if a.size else 0
        ever = np.isfinite(self.arrival)
        ms = [s for s in self.series["max_speed_ms"] if s is not None]
        if not self.has_vel: self.series["max_speed_ms"] = None
        summary = {"threshold_m": self.thr, "peak_wet_area_m2": float(a[pk]) if a.size else 0.0, "peak_wet_area_time_s": float(self.time[pk]) if a.size else 0.0,
                   "peak_wet_area_fraction": float(a[pk] / self.total_area) if a.size else 0.0, "final_wet_area_m2": float(a[-1]) if a.size else 0.0,
                   "peak_volume_m3": float(max(self.series["volume_m3"])) if a.size else 0.0, "max_depth_m": float(max(self.series["max_depth_m"])) if a.size else 0.0,
                   "max_speed_ms": float(max(ms)) if ms else None, "ever_wet_nodes": int(ever.sum()), "total_nodes": int(self.arrival.size),
                   "median_arrival_min": float(np.nanmedian(self.arrival)) if ever.any() else None}
        return {"series": self.series, "summary": summary, "arrival_min": self.arrival, "duration_min": self.duration, "dmax_final": self.dmax}


def analysis_group_name(thr):
    return f"analysis/thr_{float(thr):g}"


def write_analysis(root, res):
    """Store a StreamAnalyzer result in the Zarr store (group analysis/thr_<x>)."""
    import numcodecs
    g = root.require_group(analysis_group_name(res["summary"]["threshold_m"]))
    comp = numcodecs.Zlib(level=6)
    for k in ("arrival_min", "duration_min", "dmax_final"):
        if k in g: del g[k]
        g.create_array(k, data=np.asarray(res[k], dtype=np.float32), chunks=res[k].shape, compressors=comp, fill_value=np.nan)
    g.attrs.update({"series": res["series"], "summary": res["summary"]})
    return g


def read_analysis(root, thr):
    name = analysis_group_name(thr)
    try:
        g = root[name]
    except KeyError:
        return None
    if "summary" not in g.attrs: return None
    return {"series": dict(g.attrs["series"]), "summary": dict(g.attrs["summary"]),
            "arrival_min": g["arrival_min"][:], "duration_min": g["duration_min"][:], "dmax_final": g["dmax_final"][:]}


class Project:
    """A converted project (Zarr store in cache/). Instances are cached per name."""
    _cache = {}

    @classmethod
    def open(cls, name):
        if name in cls._cache:
            return cls._cache[name]
        p = cls(name); cls._cache[name] = p
        return p

    @classmethod
    def forget(cls, name):
        cls._cache.pop(name, None)

    def __init__(self, name):
        self.name = name
        d = cache_dir(name)
        if not os.path.exists(os.path.join(d, ".zattrs")):
            raise FileNotFoundError(f"project '{name}' is not converted (no {d}); call convert_project first")
        self.g = zarr.open_group(d, mode="r")
        A = self.A = dict(self.g.attrs)
        self.ni, self.nj, self.nt = A["ni"], A["nj"], A["nt"]
        self.N = self.ni * self.nj
        self.x = self.g["grid/x"][:].astype(np.float64); self.y = self.g["grid/y"][:].astype(np.float64)
        self.has_merc = "x3857" in self.g["grid"]
        self.mx = self.g["grid/x3857"][:] if self.has_merc else None
        self.my = self.g["grid/y3857"][:] if self.has_merc else None
        self.time = self.g["time"][:]
        self.variables = dict(A["variables"])           # safe key -> original name
        self.keys = [k for k in self.variables if k != "IBC"]
        self._analysis = {}
        self._area = None

    # ---- variables
    def key(self, var):
        """Accept a safe key or the original iRIC name (case-insensitive)."""
        if var in self.variables: return var
        for k, v in self.variables.items():
            if v.lower() == var.lower() or k.lower() == var.lower(): return k
        raise KeyError(f"unknown variable '{var}'; available: {list(self.variables)}")

    def label(self, key): return self.variables.get(key, key)
    def unit(self, key): return UNITS.get(key, "-")
    def range(self, key):
        a = self.g[f"results/{key}"].attrs
        return float(a["min"]), float(a["max"])
    def is_static(self, key):
        return self.g[f"results/{key}"].shape[0] == 1

    def get(self, var, t):
        key = self.key(var)
        arr = self.g[f"results/{key}"]
        t = 0 if arr.shape[0] == 1 else self.step(t)
        return arr[t].astype(np.float64)

    def step(self, t):
        if t is None: return self.nt - 1
        t = int(t)
        if t < 0: t += self.nt
        if not 0 <= t < self.nt: raise IndexError(f"step {t} out of range 0..{self.nt - 1}")
        return t

    def step_at_time(self, seconds):
        return int(np.argmin(np.abs(self.time - seconds)))

    def info(self):
        lon, lat = self.A.get("center_lonlat", [None, None])
        return {"name": self.name, "solver": self.A.get("solver"), "solverVersion": self.A.get("solverVersion"),
                "grid": {"ni": self.ni, "nj": self.nj, "nodes": self.N, "cells": (self.ni - 1) * (self.nj - 1)},
                "steps": self.nt, "time_start_s": float(self.time[0]), "time_end_s": float(self.time[-1]),
                "time_step_s": float(self.time[1] - self.time[0]) if self.nt > 1 else None,
                "crs": self.A.get("crs"), "bbox": self.A.get("bbox"), "center_lonlat": [lon, lat],
                "total_area_m2": float(self.total_area()),
                "variables": [{"key": k, "name": self.variables[k], "unit": self.unit(k), "min": self.range(k)[0], "max": self.range(k)[1], "static": self.is_static(k)} for k in self.keys],
                "precomputed_analysis": [g for g in (self.g["analysis"].group_keys() if "analysis" in self.g else [])],
                "source": self.A.get("source_path") or self.A.get("source")}

    # ---- geometry
    def cell_areas(self):
        if self._area is None: self._area = cell_areas(self.x, self.y)
        return self._area

    def total_area(self): return self.cell_areas().sum()

    def node(self, i, j):
        """1-based (i, j) -> (row, col) indices."""
        i, j = int(i) - 1, int(j) - 1
        if not (0 <= i < self.ni and 0 <= j < self.nj): raise IndexError(f"(i={i + 1}, j={j + 1}) outside grid {self.ni}x{self.nj}")
        return j, i

    # ---- statistics
    def wet_stats(self, depth, thr, u=None, v=None):
        cm = cell_mean(depth); wet = cm > thr
        area = self.cell_areas()
        wet_area = float(area[wet].sum()); vol = float((area * cm)[wet].sum())
        nwet = depth > thr
        maxd = float(depth[nwet].max()) if nwet.any() else 0.0
        maxv = float(np.hypot(u, v)[nwet].max()) if (u is not None and nwet.any()) else None
        return {"wet_area_m2": wet_area, "volume_m3": vol, "max_depth_m": maxd, "max_speed_ms": maxv, "wet_nodes": int(nwet.sum())}

    def analyze(self, thr=0.01, progress=None, store=True):
        """Whole-run statistics + arrival time / duration maps (minutes). Uses the precomputed group when
        the threshold matches; otherwise streams through the Zarr cache step by step (and stores the result)."""
        thr = float(thr)
        if thr in self._analysis: return self._analysis[thr]
        res = read_analysis(self.g, thr)
        if res is None:
            has_vel = "Velocity_ms_1_X" in self.variables and "Velocity_ms_1_Y" in self.variables
            sa = StreamAnalyzer(self.x, self.y, self.time, thr)
            for t in range(self.nt):
                sa.step(t, self.get("Depth", t), self.get("Velocity_ms_1_X", t) if has_vel else None, self.get("Velocity_ms_1_Y", t) if has_vel else None)
                if progress and t % 10 == 0: progress(t + 1, self.nt)
            res = sa.finish()
            if store:
                try:
                    write_analysis(zarr.open_group(cache_dir(self.name), mode="a"), res)
                except Exception as e:
                    print("analysis not stored:", e)
        self._analysis[thr] = res
        return res

    def timeseries(self, var, i, j):
        r, c = self.node(i, j)
        arr = self.g[f"results/{self.key(var)}"]
        if arr.shape[0] == 1: return np.repeat(arr[0, r, c].astype(np.float64), self.nt)
        return arr[:, r, c].astype(np.float64)

    def section(self, i, j, mode, t, extra=None, thr=0.01):
        """mode 'xs': fixed i, along j.  'ls': fixed j, along i.  Returns distances and profiles at step t."""
        r, c = self.node(i, j); t = self.step(t)
        if mode == "xs": sl = (slice(None), c); marker = r
        elif mode == "ls": sl = (r, slice(None)); marker = c
        else: raise ValueError("mode must be 'xs' (cross section) or 'ls' (longitudinal)")
        xs, ys = self.x[sl], self.y[sl]
        dist = np.concatenate([[0], np.cumsum(np.hypot(np.diff(xs), np.diff(ys)))])
        out = {"mode": mode, "i": int(i), "j": int(j), "step": t, "time_s": float(self.time[t]), "distance_m": dist, "marker_distance_m": float(dist[marker]), "length_m": float(dist[-1])}
        depth = self.get("Depth", t)[sl] if "Depth" in self.variables else None
        if "Elevation" in self.variables: out["elevation_m"] = self.get("Elevation", t)[sl]
        if "WaterSurfaceElevation" in self.variables:
            w = self.get("WaterSurfaceElevation", t)[sl].copy()
            if depth is not None: w[depth <= thr] = np.nan
            out["water_surface_m"] = w
        if depth is not None: out["depth_m"] = depth
        if extra:
            k = self.key(extra); out[k] = self.get(k, t)[sl]
        return out


# ---------------------------------------------------------------- multi-project
def same_grid(projects):
    ref = projects[0]
    return all(p.ni == ref.ni and p.nj == ref.nj and np.allclose(p.x, ref.x, atol=0.05) and np.allclose(p.y, ref.y, atol=0.05) for p in projects[1:])


def diff_field(A, B, var, t, thr=0.01):
    """A - B at step t on nodes wet in either case."""
    key = A.key(var)
    va, vb = A.get(key, t), B.get(key, t)
    da, db = A.get("Depth", t), B.get("Depth", t)
    wa, wb = da > thr, db > thr
    either = wa | wb
    d = va - vb
    dd = d[either & np.isfinite(d)]
    iou = float((wa & wb).sum() / either.sum()) if either.any() else 1.0
    return {"diff": d, "mask": either, "stats": {"variable": key, "step": A.step(t), "time_s": float(A.time[A.step(t)]),
            "mean_diff": float(dd.mean()) if dd.size else 0.0, "rms_diff": float(np.sqrt((dd ** 2).mean())) if dd.size else 0.0,
            "max_abs_diff": float(np.abs(dd).max()) if dd.size else 0.0, "wet_nodes_a": int(wa.sum()), "wet_nodes_b": int(wb.sum()), "wet_iou": iou}}


ENSEMBLE_METRICS = {
    "freq": ("浸水頻度（浸水したケースの割合）", "-"), "envmax": ("包絡最大水深", "m"), "envmin": ("最小の最大水深", "m"),
    "arrmin": ("最早到達時間", "min"), "arrspread": ("到達時間の幅（最遅 − 最早）", "min"),
}


def ensemble_field(projects, metric, thr=0.01):
    an = [p.analyze(thr) for p in projects]
    arr = np.stack([a["arrival_min"] for a in an]); dmax = np.stack([a["dmax_final"] for a in an])
    fin = np.isfinite(arr)
    with np.errstate(all="ignore"):
        if metric == "freq":
            v = fin.sum(axis=0) / len(projects); v = np.where(v > 0, v, np.nan)
        elif metric == "envmax":
            m = np.where(dmax > thr, dmax, -np.inf).max(axis=0); v = np.where(np.isfinite(m), m, np.nan)
        elif metric == "envmin":
            m = np.where(dmax > thr, dmax, 0).min(axis=0); v = np.where(m > 0, m, np.nan)
        elif metric == "arrmin":
            v = np.nanmin(np.where(fin, arr, np.nan), axis=0)
        elif metric == "arrspread":
            v = np.nanmax(np.where(fin, arr, np.nan), axis=0) - np.nanmin(np.where(fin, arr, np.nan), axis=0)
        else:
            raise ValueError(f"metric must be one of {list(ENSEMBLE_METRICS)}")
    label, unit = ENSEMBLE_METRICS[metric]
    ok = np.isfinite(v)
    stats = {"metric": metric, "label": label, "unit": unit, "cases": len(projects), "nodes_defined": int(ok.sum()), "total_nodes": projects[0].N,
             "min": float(np.nanmin(v)) if ok.any() else None, "max": float(np.nanmax(v)) if ok.any() else None, "mean": float(np.nanmean(v)) if ok.any() else None}
    if metric == "freq":
        stats["nodes_wet_in_all_cases"] = int((fin.all(axis=0)).sum()); stats["nodes_wet_in_any_case"] = int(fin.any(axis=0).sum())
    return {"field": v, "stats": stats}


def to_list(a, digits=4):
    """JSON-friendly rounding helper (NaN -> None)."""
    a = np.asarray(a, dtype=np.float64)
    return [None if not np.isfinite(v) else round(float(v), digits) for v in a.ravel()]
