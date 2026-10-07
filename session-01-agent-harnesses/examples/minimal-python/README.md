## The smallest Python harness

Ask for the current UTC time. The model requests a tool, the local MCP server
reads the clock, and the next request supplies that observation.

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and open a
terminal in this folder.

### Check the tool without inference

```sh
uv run --locked check-tools.py
```

This starts the local MCP server, discovers `get_current_time`, calls it and
prints its schema and result. No model or provider key is involved.

### Run the full loop

Copy `.env.example` to `.env`. Enter your own OpenRouter key and an explicit
tool-capable model ID privately. Then:

```sh
uv run --locked --env-file .env smallest-harness.py tools.py
```

At the prompt, enter:

```text
Load the time-check skill, then tell me the current UTC time from the tool.
```

Your configured OpenRouter account pays for model calls. Press **Ctrl+C** to
stop. Completed tool actions remain completed.

The program handles one prompt per process. Read its `history` list and
`while True` loop to find the request, response, tool execution and observation.
Tool arguments arrive as a JSON string; the harness decodes them before calling
the MCP client.

`skills/` contains a recipe offered through `read_skill`. The source code and
MCP server stay local. Tool declarations and returned observations enter the
model's requests.

### Change it

Add a read-only function decorated with `@mcp.tool()` in `tools.py`, then call it
directly through an MCP client before involving the model. Give it an accurate
description and explicit parameter types.

Inspect the MCP tool's `model_dump(by_alias=True)` output to see the wire
schema. The exact dependencies are recorded in the adjacent script lockfiles.
Use the optional Python syntax walkthrough from the Session 1 reading list
when a language construct is unfamiliar.

This small teaching program has no application request budget, approval UI,
persistent conversation or recovery checkpoint. Use a capped key and read-only
tools while experimenting. The HN application shows those additional harness
and application mechanisms.
