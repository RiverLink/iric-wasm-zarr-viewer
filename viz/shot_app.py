import asyncio, sys
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8765/'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='msedge')
        pg = await b.new_page(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1.25)
        pg.on('console', lambda m: print('[console]', m.type, m.text) if m.type in ('error','warning') else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        await pg.goto(BASE + '?folder=../projects'); await pg.wait_for_timeout(2500)
        print('status:', await pg.inner_text('#status')); print('perr:', await pg.inner_text('#perr'))
        await pg.screenshot(path='shots/app_list.png')
        # open single viewer via checkbox on first row
        rows = pg.locator('#plist tr')
        await rows.nth(0).locator('input[type=checkbox]').check()
        await pg.click('#openOne'); await pg.wait_for_timeout(6000)
        print('perr:', await pg.inner_text('#perr'))
        await pg.screenshot(path='shots/app_viewer.png')
        # comparison of all three
        await pg.evaluate("document.getElementById('projects').open = true"); await pg.wait_for_timeout(300)
        for k in range(3):
            cb = rows.nth(k).locator('input[type=checkbox]')
            if not await cb.is_checked(): await cb.check()
        await pg.click('#openCompare'); await pg.wait_for_timeout(8000)
        print('perr:', await pg.inner_text('#perr'))
        await pg.screenshot(path='shots/app_compare_grid.png')
        await b.close()
asyncio.run(main())
