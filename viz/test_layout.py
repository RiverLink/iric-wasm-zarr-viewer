import asyncio, os
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8765/'


async def click_wet(pg, idx=0):
    box = await pg.locator('.mapwrap canvas').nth(idx).bounding_box()
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
        ctx = await b.new_context(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1.25, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: print('[console]', m.type, m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        await pg.evaluate("() => 0")
        await pg.goto(BASE); await pg.evaluate("localStorage.removeItem('iric.compare.layout')")
        await pg.goto(BASE + '?folder=../projects&open=aaaa,synthetic_high_x1.3,synthetic_low_x0.7'); await pg.wait_for_timeout(8000)
        print('perr:', await pg.inner_text('#perr'))
        # default preset (3 maps + point/stats/table), run analysis, click a wet cell
        await pg.get_by_role('button', name='全ケース解析（浸水面積・到達時間）').click()
        for _ in range(90):
            await pg.wait_for_timeout(1000)
            if '解析完了' in await pg.evaluate("() => [...document.querySelectorAll('.compare span.sub')].map(e => e.textContent).join('|')"): break
        await pg.get_by_label('クリック動作').select_option('xs')
        await click_wet(pg, 0); await pg.wait_for_timeout(2500)
        await pg.screenshot(path='shots/layout_default.png', full_page=True)
        # custom layout: 2 x 2 = [map0, diff], [section, stats]
        await pg.evaluate("document.querySelector('.layoutbox').open = true"); await pg.wait_for_timeout(300)
        rows = pg.locator('.layoutbox input[type=number]')
        await rows.nth(0).fill('2'); await rows.nth(0).dispatch_event('input'); await pg.wait_for_timeout(300)
        await rows.nth(1).fill('2'); await rows.nth(1).dispatch_event('input'); await pg.wait_for_timeout(300)
        cells = pg.locator('.layoutbox .cells select')
        await cells.nth(0).select_option('map:0'); await pg.wait_for_timeout(300)
        await cells.nth(1).select_option('diff'); await pg.wait_for_timeout(300)
        await cells.nth(2).select_option('section'); await pg.wait_for_timeout(300)
        await cells.nth(3).select_option('stats'); await pg.wait_for_timeout(3000)
        print('cells:', await pg.evaluate("() => [...document.querySelectorAll('.layoutbox .cells select')].map(s => s.value)"))
        await pg.screenshot(path='shots/layout_custom.png', full_page=True)
        # play a moment to check section/stat sync
        await pg.get_by_role('button', name='▶ 再生').click(); await pg.wait_for_timeout(2000); await pg.get_by_role('button', name='❚❚ 停止').click()
        print('t:', await pg.inner_text('.timebar .t'))
        # reload: layout persisted?
        await pg.goto(BASE + '?folder=../projects&open=aaaa,synthetic_high_x1.3,synthetic_low_x0.7'); await pg.wait_for_timeout(7000)
        print('persisted:', await pg.evaluate("() => [...document.querySelectorAll('.layoutbox .cells select')].map(s => s.value)"))
        # preset button
        await pg.get_by_role('button', name='統合解析').click(); await pg.wait_for_timeout(2500)
        print('preset ens:', await pg.evaluate("() => [...document.querySelectorAll('.layoutbox .cells select')].map(s => s.value)"))
        await pg.screenshot(path='shots/layout_preset_ens.png')
        async with pg.expect_download(timeout=240000) as dl:
            await pg.get_by_role('button', name='レポート (pptx)').click()
        d = await dl.value; path = os.path.abspath('downloads/layout_' + d.suggested_filename); await d.save_as(path); print('report', os.path.getsize(path))
        print('err:', await pg.inner_text('.compare .err'))
        # viewer: side layout
        await pg.goto(BASE + '?folder=../projects&open=aaaa'); await pg.wait_for_timeout(6000)
        await pg.evaluate("document.querySelector('details.analysis').open = true"); await pg.wait_for_timeout(300)
        await pg.locator('details.analysis select').nth(1).select_option('side'); await pg.wait_for_timeout(1500)
        await click_wet(pg, 0); await pg.wait_for_timeout(4000)
        await pg.screenshot(path='shots/viewer_side.png')
        print('viewer err:', await pg.inner_text('.viewer .err'))
        await b.close()

asyncio.run(main())
