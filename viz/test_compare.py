import asyncio, os
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8765/'
async def wait_prog(pg, text, n=90):
    for _ in range(n):
        await pg.wait_for_timeout(1000)
        if text in await pg.inner_text('.compare .sub, .compare span.sub') if False else text in await pg.evaluate("() => [...document.querySelectorAll('.compare span.sub')].map(e=>e.textContent).join('|')"): return True
    return False
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='msedge')
        ctx = await b.new_context(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1.25, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: print('[console]', m.type, m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        await pg.goto(BASE + '?folder=../projects&open=aaaa,synthetic_high_x1.3,synthetic_low_x0.7'); await pg.wait_for_timeout(9000)
        print('perr:', await pg.inner_text('#perr'))
        # click a wet cell in the first map (scan for a cell with depth)
        box = await pg.locator('.mapwrap canvas').nth(0).bounding_box()
        cx, cy = box['x'] + box['width']*0.5, box['y'] + box['height']*0.5
        found = None
        for dx in range(0, 300, 10):
            for sx in (cx+dx, cx-dx):
                await pg.mouse.move(sx, cy); await pg.wait_for_timeout(20)
                txt = await pg.locator('.readout').nth(0).inner_text()
                if 'depth = ' in txt and float(txt.split('depth = ')[1].split(' m')[0]) > 0.5: found = sx; break
            if found: break
        await pg.mouse.click(found or cx, cy); await pg.wait_for_timeout(6000)
        await pg.screenshot(path='shots/cmp_grid_point.png')
        # run all analysis
        await pg.get_by_role('button', name='全ケース解析（浸水面積・到達時間）').click()
        ok = await wait_prog(pg, '解析完了'); print('analysis done:', ok)
        await pg.wait_for_timeout(1500)
        await pg.get_by_role('button', name='統計比較').click(); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='shots/cmp_stats.png')
        await pg.get_by_role('button', name='差分').click(); await pg.wait_for_timeout(5000)
        print('diff info:', (await pg.inner_text('.compare .stats'))[:200])
        await pg.screenshot(path='shots/cmp_diff.png')
        await pg.get_by_role('button', name='統合解析').click(); await pg.wait_for_timeout(5000)
        print('ens info:', (await pg.inner_text('.compare .stats'))[:200])
        await pg.screenshot(path='shots/cmp_ensemble_freq.png')
        await pg.select_option('.compare select >> nth=5', 'arrmin'); await pg.wait_for_timeout(3000)
        await pg.screenshot(path='shots/cmp_ensemble_arrmin.png')
        # report download
        async with pg.expect_download(timeout=180000) as dl:
            await pg.get_by_role('button', name='レポート (pptx)').click()
        d = await dl.value; path = os.path.abspath('downloads/' + d.suggested_filename); await d.save_as(path); print('downloaded', path, os.path.getsize(path))
        print('perr:', await pg.inner_text('#perr'))
        # single viewer report
        await pg.goto(BASE + '?folder=../projects&open=aaaa'); await pg.wait_for_timeout(7000)
        async with pg.expect_download(timeout=180000) as dl:
            await pg.get_by_role('button', name='レポート (pptx)').click()
        d = await dl.value; path2 = os.path.abspath('downloads/' + d.suggested_filename); await d.save_as(path2); print('downloaded', path2, os.path.getsize(path2))
        await b.close()
asyncio.run(main())
