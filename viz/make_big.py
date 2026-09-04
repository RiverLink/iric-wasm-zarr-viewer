"""Create a LARGE synthetic CGNS-like HDF5 file (iRIC layout) for scale testing of the streaming converter.

The grid of ../extracted/Case1.cgn is tiled TILE x TILE times (shifted copies) and the results are
copied per tile with a small scaling, so the file grows ~TILE^2 x while remaining a valid input for
convert.py.  Only the datasets the converter reads are written.  Output: ../projects_big/big_<TILE>x<TILE>/

  python make_big.py [TILE=3] [STEPS=181]
"""
import os, sys, time, shutil
import numpy as np, h5py

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "extracted", "Case1.cgn")
TILE = int(sys.argv[1]) if len(sys.argv) > 1 else 3
STEPS = int(sys.argv[2]) if len(sys.argv) > 2 else 181
OUT_DIR = os.path.join(HERE, "..", "projects_big", f"big_{TILE}x{TILE}")
os.makedirs(OUT_DIR, exist_ok=True)
OUT = os.path.join(OUT_DIR, "Case1.cgn")

src = h5py.File(SRC, "r")
zone = src["iRIC/iRICZone"]
ni, nj = [int(v) for v in zone[" data"][()][0]]
x = zone["GridCoordinates/CoordinateX/ data"][()]; y = zone["GridCoordinates/CoordinateY/ data"][()]
dx, dy = x.max() - x.min(), y.max() - y.min()
NI, NJ = ni * TILE, nj * TILE


def tile(a, scale=1.0):
    out = np.empty((NJ, NI), dtype=a.dtype)
    for r in range(TILE):
        for c in range(TILE):
            out[r * nj:(r + 1) * nj, c * ni:(c + 1) * ni] = a * (scale ** (r + c))
    return out


X = np.empty((NJ, NI)); Y = np.empty((NJ, NI))
for r in range(TILE):
    for c in range(TILE):
        X[r * nj:(r + 1) * nj, c * ni:(c + 1) * ni] = x + c * dx * 1.02
        Y[r * nj:(r + 1) * nj, c * ni:(c + 1) * ni] = y + r * dy * 1.02
sols = sorted([k for k in zone if k.startswith("FlowSolution")], key=lambda k: int(k[12:]))[:STEPS]
vars_ = [k for k in zone[sols[0]] if not k.startswith(" ") and " data" in zone[sols[0]][k]]
t0 = time.time()
with h5py.File(OUT, "w") as f:
    z = f.create_group("iRIC/iRICZone")
    z.create_dataset(" data", data=np.array([[NI, NJ], [NI - 1, NJ - 1], [0, 0]], dtype=np.int32))
    g = z.create_group("GridCoordinates"); g.create_dataset("CoordinateX/ data", data=X); g.create_dataset("CoordinateY/ data", data=Y)
    f.create_dataset("iRIC/BaseIterativeData/TimeValues/ data", data=src["iRIC/BaseIterativeData/TimeValues/ data"][()][:STEPS])
    for t, s in enumerate(sols):
        fs = z.create_group(s)
        for v in vars_:
            a = zone[s][v][" data"][()]
            fs.create_dataset(v + "/ data", data=tile(a, 1.0 if v in ("Elevation", "IBC") else 1.05))
        if t % 20 == 0: print(f"  step {t + 1}/{len(sols)}  {time.time() - t0:.0f} s", flush=True)
open(os.path.join(OUT_DIR, "project.xml"), "w", encoding="utf-8").write(
    '<?xml version="1.0" encoding="UTF-8"?>\n<iRICProject version="4.2.0.6981" solverName="naysflood" solverVersion="5.0.240119" coordinateSystem="EPSG:2454">'
    '<CgnsFileList current="Case1"><CgnsFileEntry filename="Case1" comment=""/></CgnsFileList></iRICProject>\n')
print(f"wrote {OUT}: grid {NI}x{NJ} ({NI * NJ} nodes), {len(sols)} steps, {os.path.getsize(OUT) / 1e9:.2f} GB in {time.time() - t0:.0f} s")
