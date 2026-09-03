"""Static-mode test: open an extracted iRIC project folder (project.xml + *.cgn) through the directory input."""
import asyncio, os, subprocess, sys, time, shutil
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8767
ROOT = os.path.join(HERE, "..")
# build a parent folder holding two project folders: the extracted aaaa and a copy named "case_folder2"
PARENT = os.path.join(ROOT, "projects_folders")


def prepare():
    os.makedirs(PARENT, exist_ok=True)
    for name in ("aaaa_folder", "case_folder2"):
        d = os.path.join(PARENT, name)
        if not os.path.exists(d):
            os.makedirs(d)
            for f in ("project.xml", "Case1.cgn", "Case1_input.cgn"):
                shutil.copy(os.path.join(ROOT, "extracted", f), d)


async def main():
    prepare()
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--directory", os.path.join(HERE, "web")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(channel="msedge")
            pg = await b.new_page(viewport={"width": 1600, "height": 1000})
            pg.on("pageerror", lambda e: print("[pageerror]", e))
            pg.on("console", lambda m: print("[console]", m.type, m.text[:160]) if m.type == "error" and "/api/" not in m.text else None)
            await pg.goto(f"http://127.0.0.1:{PORT}/"); await pg.wait_for_timeout(2500)
            await pg.evaluate("indexedDB.deleteDatabase('iric-local')")
            # 1) parent folder containing two project folders
            await pg.set_input_files("#localDir", PARENT); await pg.wait_for_timeout(800)
            print("parent folder ->", await pg.inner_text("#localStatus"))
            print("rows:", await pg.evaluate("() => [...document.querySelectorAll('#plist tr')].map(r => [...r.children].slice(1, 3).map(c => c.textContent).join(' | '))"))
            rows = pg.locator("#plist tr")
            await rows.nth(0).locator("input[type=checkbox]").check()
            t0 = time.time(); await pg.click("#openOne")
            for _ in range(240):
                await pg.wait_for_timeout(1000)
                if await pg.locator(".maparea .mapwrap").count() or await pg.inner_text("#perr"): break
            print(f"viewer in {time.time() - t0:.1f}s perr='{await pg.inner_text('#perr')}'")
            await pg.wait_for_timeout(3000)
            print("stats:", (await pg.inner_text("#grp-view-body .stats")).split("\n")[0])
            await pg.screenshot(path=os.path.join(HERE, "shots", "folder_viewer.png"))
            # 2) a single project folder selected directly
            await pg.goto(f"http://127.0.0.1:{PORT}/"); await pg.wait_for_timeout(2000)
            await pg.set_input_files("#localDir", os.path.join(PARENT, "case_folder2")); await pg.wait_for_timeout(800)
            print("single folder ->", await pg.inner_text("#localStatus"), await pg.evaluate("() => [...document.querySelectorAll('#plist tr')].map(r => r.children[1].textContent)"))
            await b.close()
    finally:
        srv.terminate()

asyncio.run(main())
