# /// script
# requires-python = ">=3.11"
# dependencies = ["fastmcp>=3,<5", "httpx<1"]
# ///
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
from fastmcp import Client


def tool(name, description, schema):
    function = {"name": name, "description": description, "parameters": schema}
    return {"type": "function", "function": function}


async def run(prompt):
    skills = {p.stem: p for p in Path("skills").glob("*.md")}
    history = [{"role": "user", "content": prompt}]
    async with Client(Path(sys.argv[1])) as mcp, httpx.AsyncClient(timeout=None) as api:
        remote = {f"mcp_{i}": t for i, t in enumerate(await mcp.list_tools())}
        tools = [
            tool(
                n,
                f"{t.name}: {t.description or ''}",
                t.model_dump(by_alias=True)["inputSchema"],
            )
            for n, t in remote.items()
        ]
        if skills:
            name = {"type": "string", "enum": list(skills)}
            our_own_skills_loading_schema = {
                "type": "object",
                "properties": {"name": name},
                "required": ["name"],
            }
            tools.append(
                tool(
                    "read_skill",
                    "Load applicable local instructions.",
                    our_own_skills_loading_schema,
                )
            )
        while True:
            r = await api.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"},
                json={
                    "model": os.environ["OPENROUTER_MODEL"],
                    "messages": history,
                    **({"tools": tools} if tools else {}),
                    "provider": {"require_parameters": True, "allow_fallbacks": False},
                    "plugins": [{"id": "context-compression", "enabled": False}],
                },
            )
            r.raise_for_status()
            body = r.json()
            if "error" in body:
                raise RuntimeError(body["error"])
            what_the_model_said = body["choices"][0]
            if what_the_model_said["finish_reason"] not in ("stop", "tool_calls"):
                raise RuntimeError(
                    f"Incomplete response: {what_the_model_said['finish_reason']}"
                )
            message = what_the_model_said["message"]
            history.append(message)
            if message.get("content"):
                print(message["content"], flush=True)
            if not message.get("tool_calls"):
                return
            for call in message["tool_calls"]:
                f = call["function"]
                name, args = f["name"], json.loads(f["arguments"])
                if name == "read_skill":
                    p = skills[args["name"]].resolve()
                    result = (
                        f"Skill directory: {p.parent}\n{p.read_text(encoding='utf-8')}"
                    )
                else:
                    result = (
                        await mcp.call_tool_mcp(remote[name].name, args)
                    ).model_dump_json()
                history.append(
                    {"role": "tool", "tool_call_id": call["id"], "content": result}
                )


try:
    asyncio.run(run(input("> ")))
except KeyboardInterrupt:
    print("\nstopped")
