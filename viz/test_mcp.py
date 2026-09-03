"""Exercise the MCP server through a real stdio client session."""
import asyncio, json, os, sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.join(HERE, "..", "projects")


def text(res):
    out = []
    for c in res.content:
        if c.type == "text": out.append(c.text)
        elif c.type == "image": out.append(f"<image {c.mimeType} {len(c.data)} b64 chars>")
    return "\n".join(out)


async def main():
    params = StdioServerParameters(command=sys.executable, args=[os.path.join(HERE, "mcp_server.py")], cwd=HERE)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tools = await s.list_tools()
            print("tools:", [t.name for t in tools.tools])

            async def call(tool, **kw):
                res = await s.call_tool(tool, kw)
                t = text(res)
                print(f"\n== {tool} {kw}\n{'ERROR ' if res.isError else ''}{t[:900]}")
                return t

            await call("list_projects", folder=PROJ)
            await call("convert_project", path=os.path.join(PROJ, "aaaa.ipro"))
            await call("project_info", name="aaaa")
            await call("field_stats", name="aaaa", variable="Depth", step=90)
            await call("point_timeseries", name="aaaa", i=76, j=24, variables="Depth,Velocity(ms-1)X")
            await call("section", name="aaaa", i=76, j=24, mode="xs", step=90)
            await call("analyze", name="aaaa", series_stride=30)
            await call("compare", names="aaaa,synthetic_high_x1.3,synthetic_low_x0.7", variable="Depth", step=90)
            await call("ensemble", names="aaaa,synthetic_high_x1.3,synthetic_low_x0.7", metric="arrmin")
            await call("render_map", name="aaaa", variable="Depth", step=90, probe_i=76, probe_j=24, section_mode="xs")
            await call("render_map", name="aaaa", variable="__arrival")
            await call("render_diff_map", name_a="synthetic_high_x1.3", name_b="aaaa", step=90)
            await call("render_ensemble_map", names="aaaa,synthetic_high_x1.3,synthetic_low_x0.7", metric="freq")
            await call("render_timeseries", names="aaaa,synthetic_high_x1.3,synthetic_low_x0.7", i=76, j=24)
            await call("render_section", names="aaaa,synthetic_high_x1.3,synthetic_low_x0.7", i=76, j=24, mode="xs", step=90)
            await call("render_stats", names="aaaa,synthetic_high_x1.3,synthetic_low_x0.7")
            await call("make_report", names="aaaa,synthetic_high_x1.3,synthetic_low_x0.7", step=90, probe_i=76, probe_j=24, section_mode="xs")
            await call("make_report", names="aaaa", step=90, probe_i=76, probe_j=24, section_mode="ls")
            await call("open_viewer", names="aaaa,synthetic_low_x0.7", folder=PROJ, open_browser=False)

asyncio.run(main())
