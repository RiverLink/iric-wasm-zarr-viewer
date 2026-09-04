"""Background conversion job queue (worker threads) with progress, cancellation and history."""
import threading, time, itertools, collections


class Cancelled(Exception):
    pass


class JobQueue:
    """run_fn(job, progress, phase) performs one conversion; it must call progress(step, nt) regularly
    (progress raises Cancelled when the job was cancelled)."""

    def __init__(self, run_fn, workers=2, keep=200):
        self.run_fn = run_fn; self.keep = keep
        self.jobs = collections.OrderedDict()        # id -> job dict
        self.queue = collections.deque()
        self.cv = threading.Condition()
        self.ids = itertools.count(1)
        self.threads = []
        self.set_workers(workers)

    def set_workers(self, n):
        n = max(1, min(8, int(n)))
        while len(self.threads) < n:
            t = threading.Thread(target=self._worker, daemon=True, name=f"convert-{len(self.threads) + 1}"); t.start(); self.threads.append(t)
        self.workers = n   # extra threads simply idle when reduced

    def submit(self, name, path):
        with self.cv:
            for j in self.jobs.values():
                if j["name"] == name and j["state"] in ("queued", "running"): return j
            job = {"id": next(self.ids), "name": name, "path": path, "state": "queued", "step": 0, "nt": 0, "phase": "queued",
                   "submitted": time.time(), "started": None, "finished": None, "error": None, "cancel": False}
            self.jobs[job["id"]] = job; self.queue.append(job)
            while len(self.jobs) > self.keep:
                k, v = next(iter(self.jobs.items()))
                if v["state"] in ("queued", "running"): break
                del self.jobs[k]
            self.cv.notify()
            return job

    def cancel(self, job_id):
        with self.cv:
            j = self.jobs.get(int(job_id))
            if not j: return None
            if j["state"] == "queued":
                j["state"] = "cancelled"; j["finished"] = time.time()
                try: self.queue.remove(j)
                except ValueError: pass
            elif j["state"] == "running":
                j["cancel"] = True
            return j

    def get(self, job_id):
        return self.jobs.get(int(job_id))

    def for_name(self, name):
        for j in reversed(self.jobs.values()):
            if j["name"] == name: return j
        return None

    def active(self):
        return [j for j in self.jobs.values() if j["state"] in ("queued", "running")]

    def snapshot(self):
        out = []
        for j in self.jobs.values():
            d = {k: v for k, v in j.items() if k != "cancel"}
            d["elapsed"] = round((j["finished"] or time.time()) - j["started"], 1) if j["started"] else 0
            out.append(d)
        return out

    def wait(self, job, timeout=None):
        t0 = time.time()
        while job["state"] in ("queued", "running"):
            if timeout and time.time() - t0 > timeout: return job
            time.sleep(0.5)
        return job

    def _worker(self):
        while True:
            with self.cv:
                while not self.queue or self._running() >= self.workers:
                    self.cv.wait(1.0)
                job = self.queue.popleft()
                job["state"] = "running"; job["started"] = time.time(); job["phase"] = "start"
            def progress(step, nt):
                job["step"], job["nt"] = step, nt
                if job["cancel"]: raise Cancelled()
            def phase(p): job["phase"] = p
            try:
                self.run_fn(job, progress, phase)
                job["state"] = "done"; job["phase"] = "done"
            except Cancelled:
                job["state"] = "cancelled"; job["phase"] = "cancelled"
            except Exception as e:
                job["state"] = "error"; job["error"] = str(e)[:500]; job["phase"] = "error"
            job["finished"] = time.time()
            with self.cv: self.cv.notify_all()

    def _running(self):
        return sum(1 for j in self.jobs.values() if j["state"] == "running")
