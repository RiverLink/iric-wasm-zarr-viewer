import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='msedge')
        pg = await b.new_page(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1.25)
        pg.on('console', lambda m: print('[console]', m.type, m.text) if m.type in ('error',) else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        await pg.goto('http://127.0.0.1:8765/'); await pg.wait_for_timeout(4000)
        await pg.evaluate("document.getElementById('analysis').open = true"); await pg.wait_for_timeout(500)
        box = await pg.locator('#view').bounding_box()
        cx, cy = box['x'] + box['width']*0.5 + 12, box['y'] + box['height']*0.5
        # cross-section mode, click, then play and capture two frames
        await pg.select_option('#clickMode', 'xs'); await pg.mouse.click(cx, cy); await pg.wait_for_timeout(1500)
        await pg.click('#play'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path='shots/anim_xs_a.png'); t1 = await pg.inner_text('#tlabel'); c1 = await pg.inner_text('#chartInfo')
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path='shots/anim_xs_b.png'); t2 = await pg.inner_text('#tlabel')
        await pg.click('#play')
        print('xs frames:', t1, '|', t2)
        # stats chart while playing
        await pg.click('#runAll')
        for _ in range(60):
            await pg.wait_for_timeout(500)
            if '解析完了' in await pg.inner_text('#prog'): break
        await pg.click('#play'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path='shots/anim_stats.png'); await pg.click('#play')
        print('stats frame:', await pg.inner_text('#tlabel'))
        print('err:', await pg.inner_text('#err'))
        await b.close()
asyncio.run(main())
