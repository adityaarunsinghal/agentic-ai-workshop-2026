# /// script
# requires-python = ">=3.11"
# dependencies = ["fastmcp==4.0.11"]
# ///
"""Exercise the MCP connection without calling a model."""

import asyncio
from pathlib import Path

from fastmcp import Client


async def main() -> None:
    async with Client(Path(__file__).with_name("tools.py")) as client:
        tools = await client.list_tools()
        assert [tool.name for tool in tools] == ["get_current_time"]
        print(tools[0].model_dump(by_alias=True)["inputSchema"])
        result = await client.call_tool_mcp("get_current_time", {})
        assert not result.is_error
        print(result.model_dump_json())


asyncio.run(main())
