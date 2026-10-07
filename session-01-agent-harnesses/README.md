## Session 1: agents and harnesses

Watch the agent ask for HN stories. Find the tool request, the code that executes
it, and the observation sent back to the model.

### Start here

1. Download the [Session 1 slides](session-01-agent-harnesses-2026-10-07.html)
   and open the HTML file in your browser. On GitHub, use the file's download
   control. **N** opens extra explanation; **?** opens navigation and shortcuts.
2. Read [Dinner for two](readings/dinner-for-two-2026-10-07.md).
   Follow Lalima, Harry and Tim through requests, tools, memory and permissions.
3. Run the [HN demo](demo-app/README.md). Its free local preview uses scripted
   responses so you can inspect the same sequence.
4. Follow the [small Python harness](examples/minimal-python/README.md) to see
   the complete request/tool/result loop in one program. The
   [Python syntax walkthrough](readings/python-harness-guide-2026-10-07.md)
   provides optional detail.

Use the ordinary source projects between classes. The slides carry the
classroom presentation.

### Follow a complete request

In the HN demo, select **Try the example**, then **Ask**. Open **Execution** and
select each request in order.

The scripted sequence loads the briefing skill, asks for HN metadata, proposes
source cards, then returns an answer. On the next request after each tool,
find the assistant's requested call and the corresponding tool observation.
Their call IDs connect the result to the request.

The tool declaration includes its name, description and argument schema. Its
execution function remains in application code. The model receives the result
when the harness supplies it in a later request.

Answer these from the actual trace:

- Which messages and tool definitions reached the model?
- Which information became available after the tool ran?
- Who chose the action, and which code executed it?
- Why did the next request happen?
- What ended this run?

### Try one change at a time

1. **Control.** In Explore, select fixed control and repeat the example.
   Find the HN fetch before the model request. Compare this with the adaptive
   loop. Explain when application code already knows the next operation.
2. **Memory.** Save an interest and approve it. Set a different topic for the
   next briefing. Inspect the request's application context to find both the
   saved preference and the current override. The saved value stays available.
3. **Authority.** Request a reading-list save and deny it. Check that the link
   was not saved. Repeat and approve the exact change.
4. **Topology.** Enable the reviewer for one briefing. Find its separate
   instructions and evidence. Both agents share the application's request
   allowance.

The fixture demonstrates these mechanisms with scripted output. Switch to the
documented real mode when studying whether a prompt changes model behavior.

### Trace the implementation

Start with `Agent` and `runLoop` in
[pi-mini.mjs](demo-app/agent/pi-mini.mjs). Then read `createTools`,
`prepareBriefingContext`, `authorizeUserPreferencesChange` and `prepareAgent`
in [app.mjs](demo-app/agent/app.mjs).

The app README follows the remaining transport, source and storage files.
The original Pi source is optional comparison material. Begin with the working
miniature and inspect the corresponding original function when useful.

| Term | In this example |
| --- | --- |
| Model request | One supplied context and one model response |
| Turn | That response and any tool work it requests |
| Agent run | The turns used for one prompt or explicit continuation |
| Conversation/session | Retained history across prompts |
| Tool | A declaration plus executable application code |
| Skill | Instructions loaded when relevant |
| MCP | The client/server protocol used to discover and call source tools |
| Memory | Stored information that becomes context when retrieved |
| Workshop visit | The platform's hosting/funding lifetime |

### Practice for your project

Choose a small task you care about. A study coach might inspect notes and ask a
targeted question; a research assistant might decide which source to inspect
next. Describe the result that would make the first version useful.

1. Run a baseline you can explain.
2. Change one instruction or add one read-only tool. The demo README includes
   a complete time-tool example.
3. Inspect a request before and after the change. Identify the exact
   information or available action you changed.
4. Try one failure case, such as an invalid argument or unavailable source.
   Record what happened and whether the app preserved useful work.
5. Bring the change and a trace or question to the next session.

Explain why the task benefits from choosing actions after observations.
A fixed workflow is a valid design when its steps are already known.
Keep the first version small enough to understand completely.

Publish a working version on the class app store by **Tuesday, October 27,
2026, at 5 PM New York time**. Use October 28 for build fixes and rehearsal
before Demo Day on October 29. A reduced working demo follows the course-credit
instructions in the repository README.
