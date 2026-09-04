"""SQLite catalog of known iRIC projects (registered root folders, conversion state, analysis summary).

The catalog is the index the UI and the MCP tools read; it never holds result data itself.
File: <cache dir>/catalog.sqlite
"""
import os, json, sqlite3, threading, time
import analysis

DB = os.path.join(analysis.CACHE, "catalog.sqlite")
_lock = threading.Lock()

COLS = ["name", "path", "kind", "size", "mtime", "solver", "solver_version", "crs", "ni", "nj", "nt", "t_start", "t_end",
        "converted", "converted_at", "convert_seconds", "zarr_bytes", "peak_area_m2", "peak_area_time_s", "peak_area_frac", "final_area_m2",
        "max_depth_m", "max_speed_ms", "ever_wet", "total_nodes", "tags", "last_opened", "error", "root"]
SORTS = {"name": "name COLLATE NOCASE", "mtime": "mtime", "nt": "nt", "size": "size", "max_depth": "max_depth_m", "peak_area": "peak_area_m2",
         "converted_at": "converted_at", "last_opened": "last_opened", "solver": "solver"}


def connect():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    c = sqlite3.connect(DB, timeout=30, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _lock, connect() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS projects (
            name TEXT PRIMARY KEY, path TEXT, kind TEXT, size INTEGER, mtime REAL, solver TEXT, solver_version TEXT, crs TEXT,
            ni INTEGER, nj INTEGER, nt INTEGER, t_start REAL, t_end REAL, converted INTEGER DEFAULT 0, converted_at REAL, convert_seconds REAL,
            zarr_bytes INTEGER, peak_area_m2 REAL, peak_area_time_s REAL, peak_area_frac REAL, final_area_m2 REAL, max_depth_m REAL, max_speed_ms REAL,
            ever_wet INTEGER, total_nodes INTEGER, tags TEXT DEFAULT '', last_opened REAL, error TEXT, root TEXT)""")
        c.execute("CREATE TABLE IF NOT EXISTS roots (folder TEXT PRIMARY KEY, added REAL)")
        c.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)")


def _row(r):
    return {k: r[k] for k in r.keys()}


# ---------------------------------------------------------------- roots
def roots():
    with _lock, connect() as c:
        return [_row(r) for r in c.execute("SELECT * FROM roots ORDER BY added")]


def add_root(folder):
    folder = os.path.abspath(folder)
    with _lock, connect() as c:
        c.execute("INSERT OR IGNORE INTO roots (folder, added) VALUES (?, ?)", (folder, time.time()))
    return folder


def remove_root(folder, drop_projects=False):
    with _lock, connect() as c:
        c.execute("DELETE FROM roots WHERE folder = ?", (folder,))
        if drop_projects: c.execute("DELETE FROM projects WHERE root = ? AND converted = 0", (folder,))


# ---------------------------------------------------------------- projects
def upsert_scan(entry, root):
    """Register / refresh a project found by scanning a root folder (keeps conversion + analysis fields)."""
    with _lock, connect() as c:
        c.execute("""INSERT INTO projects (name, path, kind, size, mtime, solver, solver_version, crs, error, root)
                     VALUES (:name, :path, :kind, :size, :mtime, :solver, :solverVersion, :crs, :error, :root)
                     ON CONFLICT(name) DO UPDATE SET path=excluded.path, kind=excluded.kind, size=excluded.size, mtime=excluded.mtime,
                     solver=COALESCE(excluded.solver, solver), solver_version=COALESCE(excluded.solver_version, solver_version), crs=COALESCE(excluded.crs, crs),
                     error=excluded.error, root=excluded.root""",
                  {**{k: entry.get(k) for k in ("name", "path", "kind", "size", "mtime", "solver", "solverVersion", "crs", "error")}, "root": root})
        # a newer source file invalidates the conversion flag
        c.execute("UPDATE projects SET converted = 0 WHERE name = ? AND converted_at IS NOT NULL AND mtime > converted_at", (entry["name"],))


def upsert_converted(name, attrs, summary=None, zarr_bytes=None):
    with _lock, connect() as c:
        S = summary or {}
        c.execute("""INSERT INTO projects (name, path, kind, solver, solver_version, crs, ni, nj, nt, t_start, t_end, converted, converted_at, convert_seconds, zarr_bytes,
                        peak_area_m2, peak_area_time_s, peak_area_frac, final_area_m2, max_depth_m, max_speed_ms, ever_wet, total_nodes, error)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                     ON CONFLICT(name) DO UPDATE SET solver=excluded.solver, solver_version=excluded.solver_version, crs=excluded.crs, ni=excluded.ni, nj=excluded.nj, nt=excluded.nt,
                        t_start=excluded.t_start, t_end=excluded.t_end, converted=1, converted_at=excluded.converted_at, convert_seconds=excluded.convert_seconds, zarr_bytes=excluded.zarr_bytes,
                        peak_area_m2=excluded.peak_area_m2, peak_area_time_s=excluded.peak_area_time_s, peak_area_frac=excluded.peak_area_frac, final_area_m2=excluded.final_area_m2,
                        max_depth_m=excluded.max_depth_m, max_speed_ms=excluded.max_speed_ms, ever_wet=excluded.ever_wet, total_nodes=excluded.total_nodes, error=NULL,
                        path=COALESCE(projects.path, excluded.path)""",
                  (name, attrs.get("source_path"), None, attrs.get("solver"), attrs.get("solverVersion"), attrs.get("crs"), attrs.get("ni"), attrs.get("nj"), attrs.get("nt"),
                   attrs.get("t_start"), attrs.get("t_end"), time.time(), attrs.get("convert_seconds"), zarr_bytes,
                   S.get("peak_wet_area_m2"), S.get("peak_wet_area_time_s"), S.get("peak_wet_area_fraction"), S.get("final_wet_area_m2"),
                   S.get("max_depth_m"), S.get("max_speed_ms"), S.get("ever_wet_nodes"), S.get("total_nodes")))


def set_error(name, err):
    with _lock, connect() as c:
        c.execute("UPDATE projects SET error = ? WHERE name = ?", (str(err)[:500], name))


def touch(name):
    with _lock, connect() as c:
        c.execute("UPDATE projects SET last_opened = ? WHERE name = ?", (time.time(), name))


def mark_unconverted(name):
    with _lock, connect() as c:
        c.execute("UPDATE projects SET converted = 0, zarr_bytes = NULL WHERE name = ?", (name,))


def remove(name):
    with _lock, connect() as c:
        c.execute("DELETE FROM projects WHERE name = ?", (name,))


def get(name):
    with _lock, connect() as c:
        r = c.execute("SELECT * FROM projects WHERE name = ?", (name,)).fetchone()
        return _row(r) if r else None


def list_projects(q="", sort="name", desc=False, converted=None, root=None):
    order = SORTS.get(sort, "name COLLATE NOCASE") + (" DESC" if desc else " ASC")
    where, args = [], []
    if q:
        for word in q.split():
            where.append("(name LIKE ? OR solver LIKE ? OR tags LIKE ? OR path LIKE ?)"); args += [f"%{word}%"] * 4
    if converted is not None: where.append("converted = ?"); args.append(1 if converted else 0)
    if root: where.append("root = ?"); args.append(root)
    sql = "SELECT * FROM projects" + (" WHERE " + " AND ".join(where) if where else "") + f" ORDER BY {order} NULLS LAST"
    with _lock, connect() as c:
        return [_row(r) for r in c.execute(sql, args)]


def set_tags(name, tags):
    with _lock, connect() as c:
        c.execute("UPDATE projects SET tags = ? WHERE name = ?", (tags, name))


# ---------------------------------------------------------------- config
def get_config():
    defaults = {"cache_limit_gb": 50, "workers": 2}
    with _lock, connect() as c:
        for r in c.execute("SELECT key, value FROM config"):
            try: defaults[r["key"]] = json.loads(r["value"])
            except Exception: defaults[r["key"]] = r["value"]
    return defaults


def set_config(d):
    with _lock, connect() as c:
        for k, v in d.items():
            c.execute("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, json.dumps(v)))
    return get_config()


init()
