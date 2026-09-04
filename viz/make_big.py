"""Create a LARGE synthetic CGNS-like HDF5 file (iRIC layout) for scale testing of the streaming converter.

The grid of ../extracted/Case1.cgn is refined REFINE x REFINE times by bilinear interpolation of the
node coordinates and of every result field, so the geometry stays realistic (no artificial cells) while
the file grows ~REFINE^2 x.  Only the datasets the converter reads are written.
Output: ../projects_big/big_r<REFINE>/  (project.xml + Case1.cgn)

  python make_big.py [REFINE=3] [STEPS=181]
"""
import os, sys, time
import numpy as np, h5py

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "extracted", "Case1.cgn")
R = int(sys.argv[1]) if len(sys.argv) > 1 else 3
STEPS = int(sys.argv[2]) if len(sys.argv) > 2 else 181
OUT_DIR = os.path.join(HERE, "..", "projects_big", f"big_r{R}")
os.makedirs(OUT_DIR, exist_ok=True)
OUT = os.path.join(OUT_DIR, "Case1.cgn")

src = h5py.File(SRC, "r")
zone = src["iRIC/iRICZone"]
ni, nj = [int(v) for v in zone[" data"][()][0]]
NI, NJ = (ni - 1) * R + 1, (nj - 1) * R + 1
# bilinear interpolation weights (separable)
fi = np.arange(NI) / R; fj = np.arange(NJ) / R
i0 = np.minimum(fi.astype(int), ni - 2); wi = fi - i0
j0 = np.minimum(fj.astype(int), nj - 2); wj = fj - j0


def refine(a):
    a = np.asarray(a, dtype=np.float64)
    ax = a[:, i0] * (1 - wi) + a[:, i0 + 1] * wi          # along i
    return ax[j0, :] * (1 - wj)[:, None] + ax[j0 + 1, :] * wj[:, None]   # along j


X = refine(zone["GridCoordinates/CoordinateX/ data"][()]); Y = refine(zone["GridCoordinates/CoordinateY/ data"][()])
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
            fs.create_dataset(v + "/ data", data=refine(a) if a.dtype.kind == "f" else np.repeat(np.repeat(a, R, axis=0), R, axis=1)[:NJ, :NI])
        if t % 20 == 0: print(f"  step {t + 1}/{len(sols)}  {time.time() - t0:.0f} s", flush=True)
open(os.path.join(OUT_DIR, "project.xml"), "w", encoding="utf-8").write(
    '<?xml version="1.0" encoding="UTF-8"?>\n<iRICProject version="4.2.0.6981" solverName="naysflood" solverVersion="5.0.240119" coordinateSystem="EPSG:2454">'
    '<CgnsFileList current="Case1"><CgnsFileEntry filename="Case1" comment=""/></CgnsFileList></iRICProject>\n')
print(f"wrote {OUT}: grid {NI}x{NJ} ({NI * NJ} nodes), {len(sols)} steps, {os.path.getsize(OUT) / 1e9:.2f} GB in {time.time() - t0:.0f} s")
