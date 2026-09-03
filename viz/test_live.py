"""Smoke test against the published GitHub Pages site: open a local .ipro entirely in the browser."""
import asyncio, os, sys, time
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://riverlink.github.io/iric-wasm-zarr-viewer/"
HERE = os.path.dirname(os.path.abspath(__file__))
IPRO = os.path.join(HERE, "..", "projects", "aaaa.ipro")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="msedge")
        pg = await b.new_page(viewport={"width": 1600, "height": 1000})
        pg.on("pageerror", lambda e: print("[pageerror]", e))
        pg.on("console", lambda m: print("[console]", m.type, m.text[:160]) if m.type == "error" and "/api/" not in m.text else None)
        await pg.goto(BASE); await pg.wait_for_timeout(3000)
        print("title:", await pg.title(), "| mode:", await pg.inner_text("#mode"))
        await pg.set_input_files("#localFiles", [IPRO]); await pg.wait_for_timeout(500)
        await pg.locator("#plist tr").nth(0).locator("input[type=checkbox]").check()
        t0 = time.time(); await pg.click("#openOne")
        for _ in range(240):
            await pg.wait_for_timeout(1000)
            if await pg.locator(".maparea .mapwrap").count() or await pg.inner_text("#perr"): break
        print(f"viewer in {time.time() - t0:.1f}s perr='{await pg.inner_text('#perr')}'")
        await pg.wait_for_timeout(6000)
        print("stats:", (await pg.inner_text("#grp-view-body .stats")).split("\n")[0])
        await pg.screenshot(path=os.path.join(HERE, "shots", "live_pages.png"))
        await b.close()

asyncio.run(main())
