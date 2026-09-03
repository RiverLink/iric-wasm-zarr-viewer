import asyncio, os
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8765/'


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='msedge')
        ctx = await b.new_context(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1.25, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: print('[console]', m.type, m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        await pg.goto(BASE + '?folder=../projects&open=aaaa,synthetic_high_x1.3,synthetic_low_x0.7'); await pg.wait_for_timeout(8000)
        await pg.get_by_label('クリック動作').select_option('xs')
        box = await pg.locator('.mapwrap canvas').nth(0).bounding_box()
        cx, cy = box['x'] + box['width'] * 0.5, box['y'] + box['height'] * 0.5
        found = None
        for dx in range(0, 300, 8):
            for sx in (cx + dx, cx - dx):
                await pg.mouse.move(sx, cy); await pg.wait_for_timeout(20)
                txt = await pg.locator('.readout').nth(0).inner_text()
                if 'depth = ' in txt and float(txt.split('depth = ')[1].split(' m')[0]) > 0.5:
                    found = sx; break
            if found: break
        print('wet at', found)
        await pg.mouse.click(found or cx, cy); await pg.wait_for_timeout(3000)
        await pg.screenshot(path='shots/cmp_section_xs.png')
        await pg.get_by_role('button', name='▶ 再生').click(); await pg.wait_for_timeout(2500)
        await pg.get_by_role('button', name='❚❚ 停止').click()
        print('after play:', await pg.inner_text('.timebar .t'))
        await pg.get_by_label('クリック動作').select_option('ls'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path='shots/cmp_section_ls.png')
        async with pg.expect_download(timeout=240000) as dl:
            await pg.get_by_role('button', name='レポート (pptx)').click()
        d = await dl.value
        path = os.path.abspath('downloads/section_' + d.suggested_filename); await d.save_as(path)
        print('downloaded', path, os.path.getsize(path))
        print('perr:', await pg.inner_text('#perr'), '| err:', await pg.inner_text('.compare .err'))
        await b.close()

asyncio.run(main())
