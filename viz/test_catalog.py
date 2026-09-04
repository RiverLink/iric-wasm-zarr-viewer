"""Phase-2 UI test: catalog-backed data group (roots, list with job progress, queue all, open, compare)."""
import asyncio, time
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8765/'


async def rows(pg):
    return await pg.evaluate("() => [...document.querySelectorAll('#plist tr')].map(r => [...r.children].slice(1).map(c => c.textContent.trim()).join(' | '))")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='msedge')
        pg = await b.new_page(viewport={'width': 1600, 'height': 950})
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        pg.on('console', lambda m: print('[console]', m.text[:200]) if m.type == 'error' and '404' not in m.text else None)
        await pg.goto(BASE); await pg.wait_for_timeout(2500)
        print('mode:', await pg.inner_text('#mode'), '| roots:', await pg.evaluate("() => [...document.querySelectorAll('#roots .root span')].map(e => e.textContent.slice(-30))"))
        print('count:', await pg.inner_text('#pcount'), '| storage:', (await pg.inner_text('#storage'))[:80])
        r = await rows(pg); print('rows:', len(r)); [print('  ', x[:110]) for x in r[:8]]
        # search + sort
        await pg.fill('#find', 'yahagi const'); await pg.wait_for_timeout(800)
        print('search "yahagi const":', len(await rows(pg)))
        await pg.fill('#find', ''); await pg.select_option('#sort', 'nt'); await pg.click('#sortDir'); await pg.wait_for_timeout(800)
        print('sorted by nt desc:', [x[:40] for x in (await rows(pg))[:3]])
        await pg.select_option('#sort', 'name'); await pg.click('#sortDir'); await pg.wait_for_timeout(500)
        # queue all remaining
        await pg.click('#queueAll'); await pg.wait_for_timeout(2000)
        print('after queueAll:', await pg.inner_text('#convStatus'))
        await pg.screenshot(path='shots/catalog_queue.png')
        t0 = time.time()
        for _ in range(300):
            await pg.wait_for_timeout(2000)
            st = await pg.inner_text('#convStatus')
            if not st: break
        print(f'queue drained in {time.time() - t0:.0f}s')
        r = await rows(pg); print('final statuses:'); [print('  ', x[:110]) for x in r if 'yahagi' in x][:20]
        await pg.screenshot(path='shots/catalog_done.png')
        # open one converted case and a comparison of two
        await pg.fill('#find', 'yahagi_flow=const_IKSHD'); await pg.wait_for_timeout(800)
        cbs = pg.locator('#plist input[type=checkbox]')
        await cbs.nth(0).check(); await cbs.nth(1).check()
        await pg.click('#openCompare')
        for _ in range(60):
            await pg.wait_for_timeout(500)
            if await pg.locator('.maparea .panel').count() or await pg.inner_text('#perr'): break
        await pg.wait_for_timeout(4000)
        print('compare perr:', await pg.inner_text('#perr'), '| proj:', await pg.inner_text('#projName'))
        await pg.screenshot(path='shots/catalog_compare.png')
        await b.close()

asyncio.run(main())
