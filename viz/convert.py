"""iRIC project (.ipro / project folder / CGNS) -> Zarr v2 converter.

Layout of <dst>.zarr:
  grid/x, grid/y             (nj, ni) float32   node coordinates in the project CRS
  grid/x3857, grid/y3857     (nj, ni) float64   Web Mercator copy (only when a CRS is known)
  time                       (nt,)    float64   elapsed seconds
  results/<name>             (nt, nj, ni) float32, chunks (1, nj, ni), zlib
Root attributes: ni, nj, nt, variables (safe name -> original), bbox, crs, solver, ...

CLI:  python convert.py <file.ipro | project dir | file.cgn> [dst.zarr]
"""
import os, re, sys, json, time, shutil, zipfile, tempfile
import xml.etree.ElementTree as ET
import numpy as np, h5py, zarr, numcodecs


def safe(name):
    return re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_") or "x"


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


def convert_cgns(src, dst, crs=None, info=None, log=print):
    """Convert one CGNS result file to a Zarr v2 store at dst. Returns the root attributes."""
    info = dict(info or {})
    f = h5py.File(src, "r")
    base = f["iRIC"]
    zone = base["iRICZone"]
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
    log(f"grid {ni}x{nj}, {nt} steps, vars: {variables}")

    shutil.rmtree(dst, ignore_errors=True)
    comp = numcodecs.Zlib(level=6)
    root = zarr.open_group(dst, mode="w", zarr_format=2)
    g = root.create_group("grid")
    g.create_array("x", data=x, chunks=(nj, ni), compressors=comp)
    g.create_array("y", data=y, chunks=(nj, ni), compressors=comp)
    attrs = {
        "source": os.path.basename(src), "ni": ni, "nj": nj, "nt": nt,
        "bbox": [float(x.min()), float(y.min()), float(x.max()), float(y.max())],
        "crs": crs, "converted": time.strftime("%Y-%m-%d %H:%M:%S"), **info,
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
        except Exception as e:  # unknown CRS -> no basemap, still viewable
            log(f"CRS transform skipped: {e}")
    root.create_array("time", data=time_, chunks=(nt,), compressors=comp)
    res = root.create_group("results")
    names = {}
    for v in variables:
        key = safe(v)
        buf = np.empty((nt, nj, ni), dtype=np.float32)
        for t, s in enumerate(sols):
            buf[t] = zone[s][v][" data"][()]
        arr = res.create_array(key, shape=(nt, nj, ni), chunks=(1, nj, ni), dtype=np.float32, compressors=comp, fill_value=np.nan)
        arr[:] = buf
        arr.attrs["original_name"] = v
        arr.attrs["min"] = float(np.nanmin(buf)); arr.attrs["max"] = float(np.nanmax(buf))
        names[key] = v
        log(f"  {v:32s} -> results/{key:32s} [{arr.attrs['min']:.4g}, {arr.attrs['max']:.4g}]")
    attrs["variables"] = names
    root.attrs.update(attrs)
    f.close()
    return attrs


def convert_project(path, dst, log=print):
    """Convert an .ipro file, an extracted project folder, or a bare CGNS file."""
    path = os.path.abspath(path)
    name = os.path.splitext(os.path.basename(path))[0]
    if path.lower().endswith(".cgn"):
        return convert_cgns(path, dst, info={"project": name}, log=log)
    if os.path.isdir(path):
        info = read_project_xml(open(os.path.join(path, "project.xml"), "rb").read())
        cgn = os.path.join(path, info["cgns"] + ".cgn")
        return convert_cgns(cgn, dst, crs=info["crs"], info={"project": name, **{k: v for k, v in info.items() if k != "cgns"}}, log=log)
    with zipfile.ZipFile(path) as z, tempfile.TemporaryDirectory() as tmp:
        info = read_project_xml(z.read("project.xml"))
        member = info["cgns"] + ".cgn"
        log(f"extracting {member} from {os.path.basename(path)} …")
        cgn = z.extract(member, tmp)
        return convert_cgns(cgn, dst, crs=info["crs"], info={"project": name, **{k: v for k, v in info.items() if k != "cgns"}}, log=log)


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "../extracted/Case1.cgn"
    dst = sys.argv[2] if len(sys.argv) > 2 else "web/data.zarr"
    a = convert_project(src, dst)
    print("written", dst, json.dumps({k: a[k] for k in ("ni", "nj", "nt", "crs", "solver")}))
