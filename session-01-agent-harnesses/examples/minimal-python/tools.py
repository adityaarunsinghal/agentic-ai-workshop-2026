# /// script
# requires-python = ">=3.11"
# dependencies = ["fastmcp==4.0.11"]
# ///
"""A read-only MCP server for the small harness."""

from datetime import datetime, timezone

from fastmcp import FastMCP

mcp = FastMCP("time-tools")


@mcp.tool()
def get_current_time() -> str:
    """Read the current UTC time as an ISO 8601 timestamp."""
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    mcp.run()
