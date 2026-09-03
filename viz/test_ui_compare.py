"""Layout-A compare test (server mode), opened directly via the URL."""
import asyncio, os
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8765/'


async def click_wet(pg, idx=0):
    cv = pg.locator('.mapwrap canvas.view').nth(idx)
    box = await cv.bounding_box()
    cx, cy = box['x'] + box['width'] * 0.5, box['y'] + box['height'] * 0.5
    for dx in range(0, 300, 8):
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
        pg.on('console', lambda m: print('[console]', m.type, m.text[:200]) if m.type == 'error' and '404' not in m.text else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        await pg.goto(BASE); await pg.evaluate("localStorage.clear()")
        await pg.goto(BASE + '?folder=../projects&open=aaaa,synthetic_high_x1.3,synthetic_low_x0.7')
        for _ in range(60):
            await pg.wait_for_timeout(500)
            if await pg.locator('.maparea .panel').count(): break
        await pg.wait_for_timeout(5000)
        print('perr:', await pg.inner_text('#perr'), '| panels:', await pg.locator('.maparea .panel').count())
        await pg.screenshot(path='shots/A_compare.png')
        try:
            await pg.get_by_role('button', name='全ケース解析').click()
            for _ in range(90):
                await pg.wait_for_timeout(500)
                if '解析完了' in await pg.inner_text('#grp-analysis-body'): break
            await pg.get_by_label('クリック動作').select_option('xs')
            await click_wet(pg, 0); await pg.wait_for_timeout(3000)
            await pg.screenshot(path='shots/A_compare_section.png')
            await pg.evaluate("document.getElementById('grp-layout').open = true"); await pg.wait_for_timeout(400)
            await pg.locator('#grp-layout-body .presets button', has_text='差分').click(); await pg.wait_for_timeout(4000)
            print('infoline:', (await pg.inner_text('.infoline'))[:140])
            await pg.screenshot(path='shots/A_compare_diff.png')
            await pg.locator('#grp-layout-body .presets button', has_text='統計比較').click(); await pg.wait_for_timeout(2500)
            await pg.screenshot(path='shots/A_compare_stats.png')
            await pg.evaluate("document.getElementById('grp-output').open = true"); await pg.wait_for_timeout(300)
            async with pg.expect_download(timeout=240000) as dl:
                await pg.locator('#grp-output-body button', has_text='レポート').click()
            d = await dl.value; print('compare report:', d.suggested_filename)
        except Exception as e:
            print('FAILED:', str(e)[:400])
        print('err:', await pg.inner_text('#grp-view-body .err'))
        await b.close()

asyncio.run(main())
