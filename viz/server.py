"""Local app server: static web/, project catalog (registered root folders), background conversion
jobs, Zarr data serving, analysis API and PPTX report generation.  Standard library only (plus the
converter / analysis deps).

  python server.py [port]            -> http://127.0.0.1:8765/
  env: IRIC_CACHE_DIR (Zarr cache + catalog), IRIC_TMP_DIR (.ipro extraction), IRIC_WORKERS

API (catalog / jobs)
  GET  /api/roots                    registered root folders
  POST /api/roots {folder}           register a root folder and scan it
  POST /api/roots/remove {folder}
  POST /api/scan                     rescan every root, refresh the catalog
  GET  /api/catalog?q=&sort=&desc=   catalog rows (+ live job state)
  POST /api/jobs {names:[..]}        queue conversions (skips up-to-date projects)
  GET  /api/jobs                     job list with progress
  POST /api/jobs/cancel {id}
  GET  /api/storage                  cache size / free space / limit
  GET|POST /api/config               {cache_limit_gb, workers}
  POST /api/tags {name, tags}
API (data / analysis, unchanged)
  GET  /api/projects?folder=         ad-hoc folder scan (no registration)
  POST /api/convert {path}           synchronous conversion (waits for the job; used by MCP)
  GET  /api/convert/status?name=
  GET  /api/analyze?name=&thr=       GET /api/timeseries?name=&var=&i=&j=   GET /api/section?...
  POST /api/pick-folder              POST /api/report {spec}
  GET  /data/<name>/...              files of cache/<name>.zarr
"""
import os, sys, json, time, shutil, base64, threading, mimetypes, traceback, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import numpy as np
import convert, report, analysis, catalog, jobs

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CACHE = analysis.CACHE
os.makedirs(CACHE, exist_ok=True)
MIME = {".wasm": "application/wasm", ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8",
        ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml"}
dialog_lock = threading.Lock()


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


def dir_bytes(d):
    """Total size of a directory tree; files that vanish while walking (concurrent writers) are ignored."""
    total = 0
    if not os.path.isdir(d): return 0
    for r, _, fs in os.walk(d):
        for f in fs:
            try: total += os.path.getsize(os.path.join(r, f))
            except OSError: pass
    return total


def is_converted(name, mtime):
    meta = project_meta(name)
    return bool(meta) and meta.get("source_mtime", 0) >= mtime and meta.get("format") == 2


# ---------------------------------------------------------------- scanning
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
        name = convert.project_name(path)
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
        size = os.path.getsize(path) if kind == "ipro" else dir_bytes(path)
        mtime = os.path.getmtime(path) if kind == "ipro" else max([os.path.getmtime(path)] + [os.path.getmtime(os.path.join(path, f)) for f in os.listdir(path) if f.lower().endswith((".cgn", ".xml"))])
        meta = project_meta(name)
        converted = is_converted(name, mtime)
        j = queue.for_name(name)
        out.append({"name": name, "path": path, "kind": kind, "size": size, "mtime": mtime,
                    "solver": info.get("solver"), "solverVersion": info.get("solverVersion"), "crs": info.get("crs"),
                    "cgns": info.get("cgns"), "error": info.get("error"), "converted": converted,
                    "converting": bool(j and j["state"] in ("queued", "running")),
                    "meta": {k: meta.get(k) for k in ("ni", "nj", "nt", "variables", "crs", "convert_seconds")} if converted else None})
    return out


def scan_roots():
    found = 0
    for r in catalog.roots():
        try:
            for e in scan_folder(r["folder"]):
                catalog.upsert_scan(e, r["folder"]); found += 1
                if e["converted"] and not (catalog.get(e["name"]) or {}).get("converted"):
                    register_converted(e["name"])
        except FileNotFoundError:
            pass
    return found


def register_converted(name):
    meta = project_meta(name)
    if not meta: return
    S = None
    try:
        import zarr
        g = zarr.open_group(cache_dir(name), mode="r")
        thr = (meta.get("analysis_thresholds") or [convert.DEFAULT_THR])[0]
        a = analysis.read_analysis(g, thr)
        if a: S = a["summary"]
        t = g["time"][:]
        meta = {**meta, "t_start": float(t[0]), "t_end": float(t[-1])}
    except Exception as e:
        print("register_converted:", e)
    catalog.upsert_converted(name, meta, S, dir_bytes(cache_dir(name)))


# ---------------------------------------------------------------- conversion jobs
def run_job(job, progress, phase):
    name, path = job["name"], job["path"]
    dst = cache_dir(name)
    mtime = os.path.getmtime(path)
    if is_converted(name, mtime):
        register_converted(name); return
    log = lambda m: print(f"[{name}] {m}", flush=True)
    try:
        attrs = convert.convert_project(path, dst, log=log, progress=progress, phase=phase)
        import zarr
        g = zarr.open_group(dst, mode="a", zarr_format=2)
        convert.set_attrs(g, {"source_mtime": mtime, "source_path": path})
        analysis.Project.forget(name)
        for fn in (lambda: register_converted(name), lambda: enforce_cache_limit(exclude={name})):
            try: fn()
            except Exception as e: print(f"[{name}] bookkeeping: {e}", flush=True)   # never fail a finished conversion
    except jobs.Cancelled:
        shutil.rmtree(dst, ignore_errors=True); catalog.mark_unconverted(name); raise
    except Exception as e:
        shutil.rmtree(dst, ignore_errors=True); catalog.set_error(name, e); raise


queue = jobs.JobQueue(run_job, workers=int(os.environ.get("IRIC_WORKERS") or catalog.get_config().get("workers", 2)))


def enqueue(names=None, paths=None):
    out = []
    for name in names or []:
        row = catalog.get(name)
        if not row or not row.get("path"): out.append({"name": name, "error": "unknown project"}); continue
        if is_converted(name, os.path.getmtime(row["path"])): out.append({"name": name, "state": "done"}); continue
        out.append(queue.submit(name, row["path"]))
    for path in paths or []:
        name = convert.project_name(path)
        if is_converted(name, os.path.getmtime(path)): out.append({"name": name, "state": "done"}); continue
        out.append(queue.submit(name, path))
    return [{k: v for k, v in j.items() if k != "cancel"} for j in out]


def storage():
    du = shutil.disk_usage(CACHE)
    used = sum(dir_bytes(os.path.join(CACHE, d)) for d in os.listdir(CACHE) if d.endswith(".zarr"))
    cfg = catalog.get_config()
    return {"cache_dir": CACHE, "free_bytes": du.free, "total_bytes": du.total, "cache_bytes": used, "limit_bytes": float(cfg.get("cache_limit_gb", 50)) * 1e9, "workers": queue.workers}


def enforce_cache_limit(exclude=()):
    """Delete least-recently-used Zarr caches until the cache fits the configured limit."""
    limit = float(catalog.get_config().get("cache_limit_gb", 50)) * 1e9
    dirs = [d for d in os.listdir(CACHE) if d.endswith(".zarr")]
    sizes = {d: dir_bytes(os.path.join(CACHE, d)) for d in dirs}
    total = sum(sizes.values())
    if total <= limit: return []
    rows = {analysis.safe(r["name"]) + ".zarr": r for r in catalog.list_projects()}
    active = {analysis.safe(j["name"]) + ".zarr" for j in queue.active()} | {analysis.safe(n) + ".zarr" for n in exclude}
    def score(d):
        r = rows.get(d, {}); return max(r.get("last_opened") or 0, r.get("converted_at") or 0, os.path.getmtime(os.path.join(CACHE, d)))
    removed = []
    for d in sorted(dirs, key=score):
        if total <= limit: break
        if d in active: continue
        shutil.rmtree(os.path.join(CACHE, d), ignore_errors=True); total -= sizes[d]; removed.append(d)
        r = rows.get(d)
        if r: catalog.mark_unconverted(r["name"]); analysis.Project.forget(r["name"])
    if removed: print("cache limit: removed", removed, flush=True)
    return removed


def do_convert(path):
    """Synchronous conversion (MCP / CLI): queue the job and wait for it."""
    name = convert.project_name(path)
    if is_converted(name, os.path.getmtime(path)):
        register_converted(name)
        return {"name": name, "cached": True, "meta": project_meta(name)}
    job = queue.submit(name, path)
    queue.wait(job)
    if job["state"] != "done": raise RuntimeError(job.get("error") or job["state"])
    return {"name": name, "cached": False, "meta": project_meta(name)}


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


def catalog_rows(q="", sort="name", desc=False):
    rows = catalog.list_projects(q, sort, desc)
    live = {j["name"]: j for j in queue.snapshot() if j["state"] in ("queued", "running")}
    for r in rows:
        j = live.get(r["name"])
        r["job"] = {k: j[k] for k in ("id", "state", "step", "nt", "phase", "elapsed")} if j else None
        r["converted"] = bool(r["converted"]) and os.path.exists(os.path.join(cache_dir(r["name"]), ".zattrs"))
    return rows


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else "") and "/api/jobs" not in args[0] and "/api/catalog" not in args[0]:
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
            if u.path == "/api/roots":
                return self.send_json({"roots": catalog.roots()})
            if u.path == "/api/catalog":
                return self.send_json({"projects": catalog_rows(q.get("q", ""), q.get("sort", "name"), q.get("desc") in ("1", "true")), "roots": catalog.roots()})
            if u.path == "/api/jobs":
                return self.send_json({"jobs": queue.snapshot()[-50:]})
            if u.path == "/api/storage":
                return self.send_json(storage())
            if u.path == "/api/config":
                return self.send_json(catalog.get_config())
            if u.path == "/api/convert/status":
                j = queue.for_name(q.get("name"))
                if not j: return self.send_json({"done": True, "phase": "idle"})
                return self.send_json({"step": j["step"], "nt": j["nt"], "done": j["state"] not in ("queued", "running"), "phase": j["phase"], "error": j["error"], "elapsed": round(time.time() - (j["started"] or time.time()), 1), "state": j["state"]})
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
                if rest == ".zgroup": catalog.touch(name)
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
            if u.path == "/api/roots":
                folder = catalog.add_root(body["folder"])
                if not os.path.isdir(folder): catalog.remove_root(folder); return self.send_json({"error": f"フォルダが見つかりません: {folder}"}, 404)
                scan_roots()
                return self.send_json({"folder": folder, "projects": catalog_rows(), "roots": catalog.roots()})
            if u.path == "/api/roots/remove":
                catalog.remove_root(body["folder"], drop_projects=True)
                return self.send_json({"projects": catalog_rows(), "roots": catalog.roots()})
            if u.path == "/api/scan":
                n = scan_roots()
                return self.send_json({"found": n, "projects": catalog_rows(), "roots": catalog.roots()})
            if u.path == "/api/jobs":
                return self.send_json({"jobs": enqueue(body.get("names"), body.get("paths"))})
            if u.path == "/api/jobs/cancel":
                j = queue.cancel(body["id"])
                return self.send_json({"job": {k: v for k, v in (j or {}).items() if k != "cancel"}})
            if u.path == "/api/config":
                cfg = catalog.set_config({k: body[k] for k in ("cache_limit_gb", "workers") if k in body})
                if "workers" in body: queue.set_workers(int(body["workers"]))
                enforce_cache_limit()
                return self.send_json(cfg)
            if u.path == "/api/tags":
                catalog.set_tags(body["name"], body.get("tags", "")); return self.send_json({"ok": True})
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
    print(f"iRIC wasm+zarr app: http://127.0.0.1:{port}/   (cache: {CACHE}, workers: {queue.workers})", flush=True)
    threading.Thread(target=scan_roots, daemon=True).start()
    srv.serve_forever()
