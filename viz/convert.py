"""iRIC project (.ipro / project folder / CGNS) -> Zarr v2 converter, streaming one time step at a time.

Memory use is independent of the number of steps: each FlowSolution dataset is read once and written as
one Zarr chunk, and the whole-run analysis (wet area, volume, arrival time, ...) is accumulated in the
same pass (see analysis.StreamAnalyzer) and stored under analysis/thr_<threshold>.

Layout of <dst>.zarr:
  grid/x, grid/y             (nj, ni) float32   node coordinates in the project CRS
  grid/x3857, grid/y3857     (nj, ni) float64   Web Mercator copy (only when a CRS is known)
  time                       (nt,)    float64   elapsed seconds
  results/<name>             (nt, nj, ni) float32, chunks (1, nj, ni), zlib; time-invariant variables
                             (e.g. Elevation) are stored once with shape (1, nj, ni) and attr static=true
  analysis/thr_0.01/         arrival_min, duration_min, dmax_final (nj, ni) + attrs series / summary
Root attributes: ni, nj, nt, variables (safe name -> original), bbox, crs, solver, ...

CLI:  python convert.py <file.ipro | project dir | file.cgn> [dst.zarr]
"""
import os, re, sys, json, time, shutil, zipfile, tempfile
import xml.etree.ElementTree as ET
import numpy as np, h5py, zarr, numcodecs
import analysis

DEFAULT_THR = 0.01


def safe(name):
    return analysis.safe(name)


def project_name(path):
    """Display / cache name of a project path: folder name as is, file name without extension."""
    base = os.path.basename(os.path.normpath(path))
    return base if os.path.isdir(path) else os.path.splitext(base)[0]


def set_attrs(arr, d, tries=12):
    """attrs.update with retries: on Windows the atomic rename of .zattrs can fail transiently
    (virus scanner / indexer holding the file)."""
    for k in range(tries):
        try:
            arr.attrs.update(d); return
        except PermissionError:
            if k == tries - 1: raise
            time.sleep(0.25 * (k + 1))


def read_project_xml(xml_bytes):
    root = ET.fromstring(xml_bytes)
    info = {
        "solver": root.get("solverName", ""), "solverVersion": root.get("solverVersion", ""),
        "crs": root.get("coordinateSystem", "") or None, "iricVersion": root.get("version", ""),
        "offsetX": float(root.get("offsetX", 0) or 0), "offsetY": float(root.get("offsetY", 0) or 0),
    }
    lst = root.find("CgnsFileList")
    info["cgns"] = (lst.get("current") if lst is not None else None) or "Case1"
    return info


def convert_cgns(src, dst, crs=None, info=None, log=print, thr=DEFAULT_THR, progress=None, phase=lambda p: None):
    """Convert one CGNS result file to a Zarr v2 store at dst (streaming). Returns the root attributes.
    progress(step, nt) is called every few steps."""
    info = dict(info or {})
    t_start = time.time()
    f = h5py.File(src, "r")
    if "iRIC" not in f or "iRICZone" not in f["iRIC"]:
        raise ValueError("iRIC の格子データ（iRIC/iRICZone）がありません")
    base = f["iRIC"]
    zone = base["iRICZone"]
    if not any(re.fullmatch(r"FlowSolution\d+", k) for k in zone) or "BaseIterativeData" not in base or "TimeValues" not in base["BaseIterativeData"]:
        raise ValueError("計算結果（FlowSolution / TimeValues）がありません。計算が実行されていないか、結果が保存されていないプロジェクトです")
    ni, nj = [int(v) for v in zone[" data"][()][0]]
    x = zone["GridCoordinates/CoordinateX/ data"][()].astype(np.float32)
    y = zone["GridCoordinates/CoordinateY/ data"][()].astype(np.float32)
    assert x.shape == (nj, ni), x.shape
    time_ = base["BaseIterativeData/TimeValues/ data"][()].astype(np.float64)
    nt = len(time_)
    sols = sorted([k for k in zone if re.fullmatch(r"FlowSolution\d+", k)], key=lambda k: int(k[len("FlowSolution"):]))
    if len(sols) != nt:
        nt = min(nt, len(sols)); sols = sols[:nt]; time_ = time_[:nt]
    first = zone[sols[0]]
    variables = [k for k in first if not k.startswith(" ") and " data" in first[k]]
    read = lambda t, v: zone[sols[t]][v][" data"][()]
    keymap = analysis.canonical_keys(variables)          # original name -> canonical key
    log(f"grid {ni}x{nj} ({ni * nj} nodes), {nt} steps, vars: {variables}")
    log("keys: " + ", ".join(f"{v}->{k}" for v, k in keymap.items() if safe(v) != k))
    phase('convert')

    # time-invariant variables are stored once (compare first / middle / last step)
    static = {}
    for v in variables:
        a0 = read(0, v)
        static[v] = nt > 2 and np.array_equal(a0, read(nt - 1, v)) and np.array_equal(a0, read(nt // 2, v))
    log("static variables: " + (", ".join(v for v in variables if static[v]) or "none"))

    shutil.rmtree(dst, ignore_errors=True)
    comp = numcodecs.Zlib(level=4)
    root = zarr.open_group(dst, mode="w", zarr_format=2)
    g = root.create_group("grid")
    g.create_array("x", data=x, chunks=(nj, ni), compressors=comp)
    g.create_array("y", data=y, chunks=(nj, ni), compressors=comp)
    attrs = {
        "source": os.path.basename(src), "ni": ni, "nj": nj, "nt": nt,
        "bbox": [float(x.min()), float(y.min()), float(x.max()), float(y.max())],
        "crs": crs, "converted": time.strftime("%Y-%m-%d %H:%M:%S"), "format": 2, **info,
    }
    if crs:
        try:
            from pyproj import Transformer
            to3857 = Transformer.from_crs(crs, "EPSG:3857", always_xy=True)
            to4326 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
            mx, my = to3857.transform(x.astype(np.float64), y.astype(np.float64))
            g.create_array("x3857", data=mx, chunks=(nj, ni), compressors=comp)
            g.create_array("y3857", data=my, chunks=(nj, ni), compressors=comp)
            lon, lat = to4326.transform(float(x.mean()), float(y.mean()))
            attrs["bbox3857"] = [float(mx.min()), float(my.min()), float(mx.max()), float(my.max())]
            attrs["center_lonlat"] = [lon, lat]
            log(f"center lon/lat = {lon:.5f}, {lat:.5f}")
        except Exception as e:
            log(f"CRS transform skipped: {e}")
    root.create_array("time", data=time_, chunks=(nt,), compressors=comp)
    res = root.create_group("results")
    arrays, names, lo, hi = {}, {}, {}, {}
    for v in variables:
        key = keymap[v]; names[key] = v
        n = 1 if static[v] else nt
        arrays[v] = res.create_array(key, shape=(n, nj, ni), chunks=(1, nj, ni), dtype=np.float32, compressors=comp, fill_value=np.nan)
        lo[v], hi[v] = np.inf, -np.inf

    # ---- streaming pass: write chunks and accumulate the analysis
    keys = {k: v for v, k in keymap.items()}
    has_vel = "Velocity_ms_1_X" in keys and "Velocity_ms_1_Y" in keys and "Depth" in keys
    sa = analysis.StreamAnalyzer(x, y, time_, thr) if "Depth" in keys else None
    for t in range(nt):
        cur = {}
        for v in variables:
            if static[v] and t > 0: continue
            a = read(t, v).astype(np.float32)
            arrays[v][t] = a
            fin = np.isfinite(a)
            if fin.any(): lo[v] = min(lo[v], float(a[fin].min())); hi[v] = max(hi[v], float(a[fin].max()))
            cur[v] = a
        if sa is not None:
            sa.step(t, cur[keys["Depth"]], cur.get(keys.get("Velocity_ms_1_X")), cur.get(keys.get("Velocity_ms_1_Y")))
        if progress and (t % 10 == 0 or t == nt - 1): progress(t + 1, nt)
        if t % 50 == 0 or t == nt - 1: log(f"  step {t + 1}/{nt}  ({time.time() - t_start:.1f} s)")
    phase('finalize')
    for v in variables:
        set_attrs(arrays[v], {"original_name": v, "static": bool(static[v]), "min": lo[v] if np.isfinite(lo[v]) else 0.0, "max": hi[v] if np.isfinite(hi[v]) else 0.0})
        log(f"  {v:32s} -> results/{keymap[v]:32s} [{arrays[v].attrs['min']:.4g}, {arrays[v].attrs['max']:.4g}]{'  (static)' if static[v] else ''}")
    attrs["variables"] = names
    if sa is not None:
        r = sa.finish(); analysis.write_analysis(root, r)
        attrs["analysis_thresholds"] = [thr]
        S = r["summary"]
        log(f"analysis: peak wet area {S['peak_wet_area_m2'] / 1e6:.3f} km2 @ {S['peak_wet_area_time_s']:g} s, max depth {S['max_depth_m']:.2f} m")
    attrs["convert_seconds"] = round(time.time() - t_start, 1)
    set_attrs(root, attrs)
    f.close()
    log(f"done in {attrs['convert_seconds']} s")
    return attrs


def convert_project(path, dst, log=print, thr=DEFAULT_THR, progress=None, phase=lambda p: None):
    """Convert an .ipro file, an extracted project folder, or a bare CGNS file."""
    path = os.path.abspath(path)
    name = project_name(path)
    if path.lower().endswith(".cgn"):
        return convert_cgns(path, dst, info={"project": name}, log=log, thr=thr, progress=progress, phase=phase)
    if os.path.isdir(path):
        info = read_project_xml(open(os.path.join(path, "project.xml"), "rb").read())
        cgn = os.path.join(path, info["cgns"] + ".cgn")
        return convert_cgns(cgn, dst, crs=info["crs"], info={"project": name, **{k: v for k, v in info.items() if k != "cgns"}}, log=log, thr=thr, progress=progress, phase=phase)
    with zipfile.ZipFile(path) as z, tempfile.TemporaryDirectory(dir=os.environ.get("IRIC_TMP_DIR")) as tmp:
        info = read_project_xml(z.read("project.xml"))
        member = info["cgns"] + ".cgn"
        log(f"extracting {member} from {os.path.basename(path)} …"); phase('extract')
        cgn = z.extract(member, tmp)
        return convert_cgns(cgn, dst, crs=info["crs"], info={"project": name, **{k: v for k, v in info.items() if k != "cgns"}}, log=log, thr=thr, progress=progress, phase=phase)


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "../extracted/Case1.cgn"
    dst = sys.argv[2] if len(sys.argv) > 2 else "web/data.zarr"
    a = convert_project(src, dst)
    print("written", dst, json.dumps({k: a[k] for k in ("ni", "nj", "nt", "crs", "solver", "convert_seconds")}))
