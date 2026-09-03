import sys, asyncio
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/'
async def main():
    async with async_playwright() as p:
        try: b = await p.chromium.launch(channel='msedge')
        except Exception as e:
            print('msedge failed', e); b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1600, 'height': 900}, device_scale_factor=1.25)
        pg.on('console', lambda m: print('[console]', m.type, m.text))
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        await pg.goto(URL); await pg.wait_for_timeout(5000)
        print('stats:', await pg.inner_text('#stats')); print('attr:', await pg.inner_text('#attr'))
        await pg.screenshot(path='shots/map_pale_depth_t90.png')
        await pg.select_option('#basemap', 'gsi_photo'); await pg.wait_for_timeout(5000)
        await pg.screenshot(path='shots/map_photo_depth_t90.png')
        await pg.select_option('#basemap', 'osm'); await pg.wait_for_timeout(5000)
        await pg.screenshot(path='shots/map_osm_depth_t90.png')
        # zoom in twice at the river centre and check tiles refresh
        await pg.mouse.move(750, 400); await pg.mouse.wheel(0, -300); await pg.wait_for_timeout(300); await pg.mouse.wheel(0, -300); await pg.wait_for_timeout(5000)
        await pg.select_option('#basemap', 'gsi_std'); await pg.wait_for_timeout(5000)
        print('stats zoomed:', await pg.inner_text('#stats'))
        await pg.screenshot(path='shots/map_std_zoom.png')
        await pg.click('#fit'); await pg.select_option('#basemap', 'none'); await pg.wait_for_timeout(1500)
        print('stats:', await pg.inner_text('#stats')); print('err:', await pg.inner_text('#err'))
        print('tlabel:', await pg.inner_text('#tlabel'))
        await pg.screenshot(path='shots/depth_t90.png')
        # water surface elevation, turbo
        await pg.select_option('#var', 'WaterSurfaceElevation'); await pg.select_option('#cmap', '4'); await pg.wait_for_timeout(800)
        await pg.screenshot(path='shots/wse_t90.png')
        # velocity magnitude max at last step, viridis, no arrows
        await pg.select_option('#var', 'Velocity_magnitude_Max'); await pg.select_option('#cmap', '0'); await pg.uncheck('#vec')
        await pg.fill('#time', '180'); await pg.evaluate("document.getElementById('time').dispatchEvent(new Event('input'))"); await pg.wait_for_timeout(800)
        await pg.screenshot(path='shots/velmax_t180.png')
        # depth early step with grid lines, hover readout
        await pg.select_option('#var', 'Depth'); await pg.select_option('#cmap', '2'); await pg.check('#vec'); await pg.check('#grid')
        await pg.fill('#time', '20'); await pg.evaluate("document.getElementById('time').dispatchEvent(new Event('input'))"); await pg.wait_for_timeout(800)
        await pg.mouse.move(700, 350); await pg.wait_for_timeout(300)
        print('readout:', await pg.inner_text('#readout'))
        await pg.screenshot(path='shots/depth_t20_grid.png')
        # play for a bit to exercise the animation path
        await pg.click('#play'); await pg.wait_for_timeout(3000); await pg.click('#play')
        print('after play tlabel:', await pg.inner_text('#tlabel')); print('stats:', await pg.inner_text('#stats')); print('err:', await pg.inner_text('#err'))
        await b.close()
asyncio.run(main())
