"""Layout-A UI test (server mode): sidebar groups, viewer with drawer, compare dashboard, reports."""
import asyncio, os, time
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8765/'
HERE = os.path.dirname(os.path.abspath(__file__))


async def click_wet(pg, idx=0):
    cv = pg.locator('.mapwrap canvas.view').nth(idx)
    box = await cv.bounding_box()
    cx, cy = box['x'] + box['width'] * 0.5, box['y'] + box['height'] * 0.5
    for dx in range(0, 400, 8):
        for sx in (cx + dx, cx - dx):
            await pg.mouse.move(sx, cy); await pg.wait_for_timeout(15)
            txt = await pg.locator('.readout').nth(idx).inner_text()
            if 'depth = ' in txt and float(txt.split('depth = ')[1].split(' m')[0]) > 0.5:
                await pg.mouse.click(sx, cy); return True
    await pg.mouse.click(cx, cy); return False


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='msedge')
        ctx = await b.new_context(viewport={'width': 1600, 'height': 950}, device_scale_factor=1.25, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: print('[console]', m.type, m.text[:200]) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        await pg.goto(BASE + '?folder=../projects'); await pg.wait_for_timeout(2500)
        await pg.evaluate("localStorage.clear()")
        await pg.screenshot(path='shots/A_start.png')
        # ---- single viewer
        await pg.locator('#plist tr').nth(0).locator('input[type=checkbox]').check()
        await pg.click('#openOne')
        for _ in range(60):
            await pg.wait_for_timeout(500)
            if await pg.locator('.maparea .mapwrap').count(): break
        await pg.wait_for_timeout(5000)
        print('viewer perr:', await pg.inner_text('#perr'), '| proj:', await pg.inner_text('#projName'), '| chip:', await pg.inner_text('#modeChip'))
        await pg.screenshot(path='shots/A_viewer.png')
        await click_wet(pg); await pg.wait_for_timeout(5000)
        print('drawer open:', await pg.evaluate("!document.querySelector('.drawer').hidden"), '| info:', await pg.inner_text('.drawer .info'))
        await pg.screenshot(path='shots/A_viewer_ts.png')
        # section + analysis + stats tab
        await pg.get_by_label('クリック動作').select_option('xs'); await pg.wait_for_timeout(2500)
        await pg.get_by_role('button', name='全ステップ解析').click()
        for _ in range(60):
            await pg.wait_for_timeout(500)
            if '解析完了' in await pg.inner_text('#grp-analysis-body'): break
        await pg.wait_for_timeout(1000)
        await pg.screenshot(path='shots/A_viewer_stats.png')
        # keyboard: right arrow steps, space plays
        t0 = await pg.inner_text('.timebar .t'); await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(600)
        print('key step:', t0, '->', await pg.inner_text('.timebar .t'))
        # right-docked drawer + sidebar collapse
        await pg.locator('#grp-analysis-body select').nth(1).select_option('side'); await pg.wait_for_timeout(1500)
        await pg.click('#toggleSidebar'); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='shots/A_viewer_side_nosb.png')
        await pg.click('#showSidebar'); await pg.wait_for_timeout(800)
        await pg.evaluate("document.getElementById('grp-output').open = true"); await pg.wait_for_timeout(300)
        async with pg.expect_download(timeout=180000) as dl:
            await pg.get_by_role('button', name='レポート (pptx)').click()
        d = await dl.value; print('viewer report:', d.suggested_filename)
        # ---- compare
        await pg.evaluate("document.getElementById('grp-data').open = true"); await pg.wait_for_timeout(300)
        rows = pg.locator('#plist tr')
        for k in range(3):
            cb = rows.nth(k).locator('input[type=checkbox]')
            if not await cb.is_checked(): await cb.check()
        await pg.click('#openCompare')
        for _ in range(60):
            await pg.wait_for_timeout(500)
            if await pg.locator('.maparea .panel').count(): break
        await pg.wait_for_timeout(5000)
        print('compare perr:', await pg.inner_text('#perr'), '| panels:', await pg.locator('.maparea .panel').count(), '| layout grp visible:', not await pg.evaluate("document.getElementById('grp-layout').hidden"))
        await pg.screenshot(path='shots/A_compare.png')
        await pg.get_by_role('button', name='全ケース解析').click()
        for _ in range(90):
            await pg.wait_for_timeout(500)
            if '解析完了' in await pg.inner_text('#grp-analysis-body'): break
        await pg.get_by_label('クリック動作').select_option('xs')
        await click_wet(pg, 0); await pg.wait_for_timeout(3000)
        await pg.evaluate("document.getElementById('grp-layout').open = true"); await pg.wait_for_timeout(300)
        await pg.get_by_role('button', name='差分').click(); await pg.wait_for_timeout(4000)
        print('infoline:', (await pg.inner_text('.infoline'))[:120])
        await pg.screenshot(path='shots/A_compare_diff.png')
        await pg.evaluate("document.getElementById('grp-output').open = true"); await pg.wait_for_timeout(300)
        async with pg.expect_download(timeout=240000) as dl:
            await pg.get_by_role('button', name='レポート (pptx)').click()
        d = await dl.value; print('compare report:', d.suggested_filename)
        print('err:', await pg.inner_text('#grp-view-body .err'))
        await b.close()

asyncio.run(main())
