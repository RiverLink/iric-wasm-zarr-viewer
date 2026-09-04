"""Local app server: static web/, project folder scanning, .ipro -> Zarr conversion cache,
Zarr data serving, analysis API and PPTX report generation.  Standard library only (plus the
converter / analysis deps).

  python server.py [port]            -> http://127.0.0.1:8765/
API
  GET  /api/projects?folder=<path>   list iRIC projects (*.ipro or folders with project.xml)
  POST /api/convert   {"path": ...}  convert one project into cache/<name>.zarr (skipped if up to date)
  GET  /api/convert/status?name=     progress of a running conversion {"step", "nt", "done", "error"}
  GET  /api/analyze?name=&thr=       whole-run statistics (precomputed at conversion, else streamed)
  GET  /api/timeseries?name=&var=&i=&j=   node time series (1-based i, j)
  GET  /api/section?name=&i=&j=&mode=&t=&var=&thr=
  POST /api/pick-folder              open a native folder dialog on this machine, return the path
  POST /api/report    {spec}         build a .pptx from the report spec (see report.py)
  GET  /data/<name>/...              files of cache/<name>.zarr
"""
import os, sys, json, base64, threading, mimetypes, traceback, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import numpy as np
import convert, report, analysis

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CACHE = analysis.CACHE
os.makedirs(CACHE, exist_ok=True)
MIME = {".wasm": "application/wasm", ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8",
        ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml"}
convert_lock = threading.Lock()
dialog_lock = threading.Lock()
convert_status = {}     # name -> {"step", "nt", "done", "error"}


def cache_dir(name):
    return analysis.cache_dir(name)


def project_meta(name):
    p = os.path.join(cache_dir(name), ".zattrs")
    if not os.path.exists(p):
        return None
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return None


def scan_folder(folder):
    out = []
    if not os.path.isdir(folder):
        raise FileNotFoundError(folder)
    for entry in sorted(os.listdir(folder)):
        path = os.path.join(folder, entry)
        kind = None
        if entry.lower().endswith(".ipro") and os.path.isfile(path):
            kind = "ipro"
        elif os.path.isdir(path) and os.path.exists(os.path.join(path, "project.xml")):
            kind = "folder"
        if not kind:
            continue
        name = os.path.splitext(entry)[0] if kind == "ipro" else entry
        info = {}
        try:
            if kind == "ipro":
                import zipfile
                with zipfile.ZipFile(path) as z:
                    info = convert.read_project_xml(z.read("project.xml"))
            else:
                info = convert.read_project_xml(open(os.path.join(path, "project.xml"), "rb").read())
        except Exception as e:
            info = {"error": str(e)}
        size = os.path.getsize(path) if kind == "ipro" else sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(path) for f in fs)
        mtime = os.path.getmtime(path)
        meta = project_meta(name)
        converted = bool(meta) and meta.get("source_mtime", 0) >= mtime and meta.get("format") == 2
        st = convert_status.get(name)
        out.append({"name": name, "path": path, "kind": kind, "size": size, "mtime": mtime,
                    "solver": info.get("solver"), "solverVersion": info.get("solverVersion"), "crs": info.get("crs"),
                    "cgns": info.get("cgns"), "error": info.get("error"), "converted": converted,
                    "converting": bool(st and not st.get("done")),
                    "meta": {k: meta.get(k) for k in ("ni", "nj", "nt", "variables", "crs", "convert_seconds")} if converted else None})
    return out


def do_convert(path):
    name = os.path.splitext(os.path.basename(path))[0]
    dst = cache_dir(name)
    mtime = os.path.getmtime(path)
    meta = project_meta(name)
    if meta and meta.get("source_mtime", 0) >= mtime and meta.get("format") == 2:
        return {"name": name, "cached": True, "meta": meta}
    with convert_lock:
        log = []
        st = convert_status[name] = {"step": 0, "nt": 0, "done": False, "error": None}
        def progress(step, nt): st["step"], st["nt"] = step, nt
        try:
            attrs = convert.convert_project(path, dst, log=lambda m: (log.append(str(m)), print(m)), progress=progress)
            import zarr
            g = zarr.open_group(dst, mode="a", zarr_format=2)
            g.attrs["source_mtime"] = mtime
            g.attrs["source_path"] = path
            attrs["source_mtime"] = mtime
        except Exception as e:
            st["error"] = str(e); st["done"] = True; raise
        st["done"] = True
        analysis.Project.forget(name)
    return {"name": name, "cached": False, "meta": attrs, "log": log}


def pick_folder(initial):
    with dialog_lock:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True)
        try:
            return filedialog.askdirectory(initialdir=initial or HERE, title="iRIC プロジェクトが入ったフォルダを選択")
        finally:
            root.destroy()


def b64f32(a):
    return base64.b64encode(np.ascontiguousarray(np.asarray(a, dtype=np.float32)).tobytes()).decode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- helpers
    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(data)

    def send_file(self, path, download=None):
        if not os.path.isfile(path):
            self.send_error(404, "File not found"); return
        ext = os.path.splitext(path)[1].lower()
        ctype = MIME.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1 << 16)
                if not chunk: break
                self.wfile.write(chunk)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    # ---- routes
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path == "/api/projects":
                folder = q.get("folder", "")
                return self.send_json({"folder": os.path.abspath(folder), "projects": scan_folder(folder)})
            if u.path == "/api/convert/status":
                return self.send_json(convert_status.get(q.get("name"), {"done": True}))
            if u.path == "/api/analyze":
                p = analysis.Project.open(q["name"]); thr = float(q.get("thr", convert.DEFAULT_THR))
                r = p.analyze(thr)
                return self.send_json({"name": p.name, "threshold": thr, "series": r["series"], "summary": r["summary"], "total_area_m2": float(p.total_area()),
                                       "nj": p.nj, "ni": p.ni, "arrival_min_b64": b64f32(r["arrival_min"]), "duration_min_b64": b64f32(r["duration_min"])})
            if u.path == "/api/timeseries":
                p = analysis.Project.open(q["name"])
                keys = [p.key(v) for v in q.get("var", "Depth").split(",") if v]
                i, j = int(q["i"]), int(q["j"])
                return self.send_json({"name": p.name, "i": i, "j": j, "time_s": p.time.tolist(), "series": {k: analysis.to_list(p.timeseries(k, i, j), 5) for k in keys}})
            if u.path == "/api/section":
                p = analysis.Project.open(q["name"])
                s = p.section(int(q["i"]), int(q["j"]), q.get("mode", "xs"), int(q.get("t", -1)), extra=q.get("var") or None, thr=float(q.get("thr", convert.DEFAULT_THR)))
                return self.send_json({k: (analysis.to_list(v, 4) if isinstance(v, np.ndarray) else v) for k, v in s.items()})
            if u.path.startswith("/data/"):
                parts = u.path[len("/data/"):].split("/", 1)
                name = urllib.parse.unquote(parts[0]); rest = urllib.parse.unquote(parts[1]) if len(parts) > 1 else ""
                base = cache_dir(name)
                path = os.path.normpath(os.path.join(base, rest))
                if not path.startswith(base): return self.send_error(403)
                return self.send_file(path)
            path = urllib.parse.unquote(u.path)
            if path == "/": path = "/index.html"
            full = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
            if not full.startswith(WEB): return self.send_error(403)
            return self.send_file(full)
        except FileNotFoundError as e:
            return self.send_json({"error": f"not found: {e}"}, 404)
        except Exception as e:
            traceback.print_exc(); return self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            body = self.read_body()
            if u.path == "/api/convert":
                return self.send_json(do_convert(body["path"]))
            if u.path == "/api/pick-folder":
                return self.send_json({"folder": pick_folder(body.get("initial"))})
            if u.path == "/api/report":
                out = os.path.join(CACHE, "report.pptx")
                report.build_pptx(body, out)
                return self.send_file(out, download=body.get("filename") or "iric_report.pptx")
            return self.send_json({"error": "unknown endpoint"}, 404)
        except Exception as e:
            traceback.print_exc(); return self.send_json({"error": str(e)}, 500)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer.allow_reuse_address = True
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"iRIC wasm+zarr app: http://127.0.0.1:{port}/   (cache: {CACHE})", flush=True)
    srv.serve_forever()
