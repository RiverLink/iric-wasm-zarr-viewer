"""Create SYNTHETIC test projects for exercising the comparison features.

They are derived from ../extracted (the unzipped aaaa.ipro) by scaling the flood results and are
NOT real simulation results.  Output: ../projects/<name>.ipro

  python make_synthetic.py
"""
import os, shutil, zipfile, tempfile
import numpy as np, h5py

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "extracted")
OUT = os.path.join(HERE, "..", "projects")
os.makedirs(OUT, exist_ok=True)


def zip_dir(src_dir, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for r, _, fs in os.walk(src_dir):
            for f in fs:
                p = os.path.join(r, f)
                z.write(p, os.path.relpath(p, src_dir))


def scaled_case(name, depth_scale, vel_scale, min_depth=0.01):
    with tempfile.TemporaryDirectory() as tmp:
        d = os.path.join(tmp, "p")
        shutil.copytree(SRC, d)
        with h5py.File(os.path.join(d, "Case1.cgn"), "r+") as f:
            zone = f["iRIC/iRICZone"]
            elev = None
            for k in zone:
                if not k.startswith("FlowSolution"): continue
                fs = zone[k]
                if elev is None: elev = fs["Elevation/ data"][()]
                for vn in ("Depth", "Depth(Max)"):
                    ds = fs[vn + "/ data"]; v = ds[()]
                    wet = v > min_depth
                    v[wet] = min_depth + (v[wet] - min_depth) * depth_scale
                    ds[...] = v
                dep = fs["Depth/ data"][()]
                fs["WaterSurfaceElevation/ data"][...] = elev + dep
                for vn in ("Velocity(ms-1)X", "Velocity(ms-1)Y", "Velocity (magnitude Max)"):
                    ds = fs[vn + "/ data"]; ds[...] = ds[()] * vel_scale
        out = os.path.join(OUT, name + ".ipro")
        zip_dir(d, out)
        print("wrote", out, os.path.getsize(out) // 1024, "KB")


if __name__ == "__main__":
    # original case (copied unchanged) + two synthetic variants
    shutil.copy(os.path.join(HERE, "..", "aaaa.ipro"), os.path.join(OUT, "aaaa.ipro"))
    print("copied aaaa.ipro")
    scaled_case("synthetic_low_x0.7", 0.7, 0.85)
    scaled_case("synthetic_high_x1.3", 1.3, 1.1)
