"""Server-side (numpy) analysis of converted iRIC results — the same definitions as the browser/wasm
kernels, so the MCP tools and the web viewer agree.

Conventions
  * arrays are (nj, ni) node-based, C order; i, j in the public API are 1-based (iRIC style)
  * a cell is wet when the mean of its 4 node depths exceeds `thr`; a node is wet when depth > thr
  * areas / distances use the project CRS coordinates (metres); Web Mercator only for drawing
"""
import os, re, json, math, functools
import numpy as np, zarr

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")


def safe(name):
    return re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_") or "x"


def cache_dir(name):
    return os.path.join(CACHE, safe(name) + ".zarr")


UNITS = {"Depth": "m", "Depth_Max": "m", "Elevation": "m", "WaterSurfaceElevation": "m",
         "Velocity_ms_1_X": "m/s", "Velocity_ms_1_Y": "m/s", "Velocity_magnitude_Max": "m/s"}


class Project:
    """A converted project (Zarr store in cache/). Instances are cached per name."""
    _cache = {}

    @classmethod
    def open(cls, name):
        if name in cls._cache:
            return cls._cache[name]
        p = cls(name); cls._cache[name] = p
        return p

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

    def get(self, var, t):
        key = self.key(var)
        t = self.step(t)
        return self.g[f"results/{key}"][t].astype(np.float64)

    def get_all(self, var):
        return self.g[f"results/{self.key(var)}"][:].astype(np.float64)   # (nt, nj, ni)

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
                "variables": [{"key": k, "name": self.variables[k], "unit": self.unit(k), "min": self.range(k)[0], "max": self.range(k)[1]} for k in self.keys],
                "source": self.A.get("source_path") or self.A.get("source")}

    # ---- geometry
    def cell_areas(self):
        if self._area is None:
            x, y = self.x, self.y
            xa, ya = x[:-1, :-1], y[:-1, :-1]; xb, yb = x[:-1, 1:], y[:-1, 1:]
            xc, yc = x[1:, 1:], y[1:, 1:]; xd, yd = x[1:, :-1], y[1:, :-1]
            self._area = 0.5 * np.abs((xa * yb - xb * ya) + (xb * yc - xc * yb) + (xc * yd - xd * yc) + (xd * ya - xa * yd))
        return self._area

    def total_area(self): return self.cell_areas().sum()

    def node(self, i, j):
        """1-based (i, j) -> (row, col) indices."""
        i, j = int(i) - 1, int(j) - 1
        if not (0 <= i < self.ni and 0 <= j < self.nj): raise IndexError(f"(i={i + 1}, j={j + 1}) outside grid {self.ni}x{self.nj}")
        return j, i

    def nearest_node(self, x, y):
        k = int(np.argmin((self.x - x) ** 2 + (self.y - y) ** 2))
        return k // self.ni + 1, k % self.ni + 1   # (j, i) 1-based? -> return as (i, j)

    # ---- statistics
    @staticmethod
    def cell_mean(a):
        return 0.25 * (a[:-1, :-1] + a[:-1, 1:] + a[1:, 1:] + a[1:, :-1])

    def wet_stats(self, depth, thr, u=None, v=None):
        cm = self.cell_mean(depth); wet = cm > thr
        area = self.cell_areas()
        wet_area = float(area[wet].sum()); vol = float((area * cm)[wet].sum())
        nwet = depth > thr
        maxd = float(depth[nwet].max()) if nwet.any() else 0.0
        maxv = float(np.hypot(u, v)[nwet].max()) if (u is not None and nwet.any()) else None
        return {"wet_area_m2": wet_area, "volume_m3": vol, "max_depth_m": maxd, "max_speed_ms": maxv, "wet_nodes": int(nwet.sum())}

    def analyze(self, thr=0.01):
        """Whole-run statistics + arrival time / inundation duration maps (minutes)."""
        if thr in self._analysis: return self._analysis[thr]
        D = self.get_all("Depth")
        has_vel = "Velocity_ms_1_X" in self.variables and "Velocity_ms_1_Y" in self.variables
        U = self.get_all("Velocity_ms_1_X") if has_vel else None
        V = self.get_all("Velocity_ms_1_Y") if has_vel else None
        area = self.cell_areas()
        cm = 0.25 * (D[:, :-1, :-1] + D[:, :-1, 1:] + D[:, 1:, 1:] + D[:, 1:, :-1])
        wet = cm > thr
        series = {
            "time_s": self.time.tolist(),
            "wet_area_m2": (area * wet).sum(axis=(1, 2)).tolist(),
            "volume_m3": (area * cm * wet).sum(axis=(1, 2)).tolist(),
            "max_depth_m": np.where(D > thr, D, 0).max(axis=(1, 2)).tolist(),
            "max_speed_ms": np.where(D > thr, np.hypot(U, V), 0).max(axis=(1, 2)).tolist() if has_vel else None,
        }
        nwet = D > thr
        first = np.argmax(nwet, axis=0)                       # first step index where wet
        ever = nwet.any(axis=0)
        arrival = np.where(ever, self.time[first] / 60.0, np.nan)
        dt = np.diff(self.time, append=self.time[-1] + (self.time[-1] - self.time[-2] if self.nt > 1 else 0))
        duration = (nwet * dt[:, None, None]).sum(axis=0) / 60.0
        a = np.array(series["wet_area_m2"]); pk = int(a.argmax())
        summary = {"threshold_m": thr, "peak_wet_area_m2": float(a[pk]), "peak_wet_area_time_s": float(self.time[pk]),
                   "peak_wet_area_fraction": float(a[pk] / self.total_area()), "final_wet_area_m2": float(a[-1]),
                   "peak_volume_m3": float(max(series["volume_m3"])), "max_depth_m": float(max(series["max_depth_m"])),
                   "max_speed_ms": float(max(series["max_speed_ms"])) if has_vel else None,
                   "ever_wet_nodes": int(ever.sum()), "total_nodes": self.N,
                   "median_arrival_min": float(np.nanmedian(arrival)) if ever.any() else None}
        res = {"series": series, "summary": summary, "arrival_min": arrival, "duration_min": duration, "dmax_final": self.get("Depth_Max", self.nt - 1) if "Depth_Max" in self.variables else D.max(axis=0)}
        self._analysis[thr] = res
        return res

    def timeseries(self, var, i, j):
        r, c = self.node(i, j)
        return self.g[f"results/{self.key(var)}"][:, r, c].astype(np.float64)

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
