"""Static-hosting test: serve web/ with a plain file server (no API) and open an .ipro entirely in the browser."""
import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8766
IPRO = os.path.join(HERE, "..", "projects", "aaaa.ipro")
IPRO2 = os.path.join(HERE, "..", "projects", "synthetic_low_x0.7.ipro")


async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--directory", os.path.join(HERE, "web")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(channel="msedge")
            ctx = await b.new_context(viewport={"width": 1600, "height": 1000}, accept_downloads=True)
            pg = await ctx.new_page()
            pg.on("console", lambda m: print("[console]", m.type, m.text[:200]) if m.type in ("error", "warning") else None)
            pg.on("pageerror", lambda e: print("[pageerror]", e))
            await pg.goto(f"http://127.0.0.1:{PORT}/"); await pg.wait_for_timeout(2500)
            print("mode:", await pg.inner_text("#mode"), "| folderbar hidden:", await pg.evaluate("document.getElementById('folderbar').hidden"))
            await pg.set_input_files("#localFiles", [IPRO, IPRO2]); await pg.wait_for_timeout(500)
            print("local:", await pg.inner_text("#localStatus"))
            await pg.screenshot(path="shots/static_list.png")
            rows = pg.locator("#plist tr")
            await rows.nth(0).locator("input[type=checkbox]").check()
            t0 = time.time()
            await pg.click("#openOne")
            for _ in range(240):
                await pg.wait_for_timeout(1000)
                st = await pg.inner_text("#convStatus"); err = await pg.inner_text("#perr")
                if err: print("perr:", err); break
                if await pg.locator(".viewer").count(): break
            print(f"viewer opened in {time.time() - t0:.1f} s; convStatus='{await pg.inner_text('#convStatus')}'")
            await pg.wait_for_timeout(4000)
            print("meta:", await pg.inner_text(".viewer .stats"))
            await pg.screenshot(path="shots/static_viewer.png")
            # analysis + browser pptx
            await pg.evaluate("document.querySelector('details.analysis').open = true"); await pg.wait_for_timeout(300)
            await pg.get_by_role("button", name="全ステップ解析（浸水面積・貯留量・到達時間）").click()
            for _ in range(60):
                await pg.wait_for_timeout(500)
                if "解析完了" in await pg.inner_text("details.analysis"): break
            print("analysis:", [t for t in (await pg.inner_text("details.analysis")).split("\n") if "解析" in t][:2])
            async with pg.expect_download(timeout=180000) as dl:
                await pg.get_by_role("button", name="レポート (pptx)").click()
            d = await dl.value; path = os.path.abspath(os.path.join("downloads", "static_" + d.suggested_filename)); await d.save_as(path)
            print("pptx (browser):", path, os.path.getsize(path))
            # second open should come from IndexedDB cache; then comparison of the two local projects
            await pg.goto(f"http://127.0.0.1:{PORT}/"); await pg.wait_for_timeout(2000)
            await pg.set_input_files("#localFiles", [IPRO, IPRO2]); await pg.wait_for_timeout(500)
            for k in range(2): await rows.nth(k).locator("input[type=checkbox]").check()
            t0 = time.time(); await pg.click("#openCompare")
            for _ in range(240):
                await pg.wait_for_timeout(1000)
                if await pg.locator(".compare").count() or await pg.inner_text("#perr"): break
            print(f"compare opened in {time.time() - t0:.1f} s; perr='{await pg.inner_text('#perr')}'")
            await pg.wait_for_timeout(5000)
            await pg.screenshot(path="shots/static_compare.png")
            await b.close()
    finally:
        srv.terminate()

asyncio.run(main())
