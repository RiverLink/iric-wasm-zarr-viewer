import asyncio
from playwright.async_api import async_playwright
URL = 'http://127.0.0.1:8765/'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='msedge')
        pg = await b.new_page(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1.25)
        pg.on('console', lambda m: print('[console]', m.type, m.text) if m.type in ('error','warning') else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        await pg.goto(URL); await pg.wait_for_timeout(4000)
        # open analysis panel, click on the river (centre of canvas) in time-series mode
        await pg.evaluate("document.getElementById('analysis').open = true")
        await pg.wait_for_timeout(500)
        box = await pg.locator('#view').bounding_box()
        cx, cy = box['x'] + box['width']*0.5, box['y'] + box['height']*0.5
        # find a wet cell near the centre by scanning right
        found = None
        for dx in range(0, 400, 12):
            for sx in (cx+dx, cx-dx):
                await pg.mouse.move(sx, cy); await pg.wait_for_timeout(30)
                txt = await pg.inner_text('#readout')
                if 'depth = ' in txt and float(txt.split('depth = ')[1].split(' m')[0]) > 0.5:
                    found = sx; break
            if found: break
        print('wet cell at x offset', found - cx if found else None)
        await pg.mouse.click(found or cx, cy); await pg.wait_for_timeout(6000)
        print('chartInfo ts:', await pg.inner_text('#chartInfo'))
        await pg.screenshot(path='shots/analysis_ts.png')
        # cross-section
        await pg.select_option('#clickMode', 'xs'); await pg.wait_for_timeout(1500)
        print('chartInfo xs:', await pg.inner_text('#chartInfo'))
        await pg.screenshot(path='shots/analysis_xs.png')
        # run whole-simulation analysis
        await pg.click('#runAll')
        for _ in range(60):
            await pg.wait_for_timeout(1000)
            if '解析完了' in await pg.inner_text('#prog'): break
        print('prog:', await pg.inner_text('#prog')); print('chartInfo stats:', await pg.inner_text('#chartInfo'))
        await pg.screenshot(path='shots/analysis_stats.png')
        # arrival time map
        await pg.select_option('#var', '__arrival'); await pg.select_option('#cmap', '4'); await pg.uncheck('#vec'); await pg.wait_for_timeout(1500)
        print('err:', await pg.inner_text('#err'))
        await pg.screenshot(path='shots/analysis_arrival.png')
        await b.close()
asyncio.run(main())
