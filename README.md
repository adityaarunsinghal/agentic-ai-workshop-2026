## Agentic AI workshop 2026

Build an agent around an idea you care about, share it with the class, and learn
from trying each other's projects. Materials appear here as they are released.

### Choose where to start

| Your goal | Start here | Install |
| --- | --- | --- |
| Build a small working app | [Minimal Python app](session-01-agent-harnesses/examples/smallest-valid-app/README.md): chat and one time tool | Git and uv |
| Inspect a complete agent | [HN harness](session-01-agent-harnesses/demo-app/README.md): tools, approvals, memory and execution records | Git, Node.js 22.19+, npm; uv for packaging |
| Build beyond chat | [Session 2 newspaper editor](session-02-beyond-chat-interfaces/demo-app/README.md): MCP tools, an interactive editor, editorial decisions and auto research | Git, Node.js 22.19+, npm; uv for packaging |
| Read the smallest tool loop | [Python CLI harness](session-01-agent-harnesses/examples/smallest-working-harness/README.md) | uv |
| Review the class | [Session 1 slides, reading and exercises](session-01-agent-harnesses/README.md) | A browser |
| Review Session 2 | [Beyond the Chat Interface slides](session-02-beyond-chat-interfaces/slides/session-02-beyond-chat-interfaces-2026-10-15.html) | A browser |
| Compare agent topologies | [Session 3 multi-agent fact-checker](session-03-multi-agent-topologies/demo-app/README.md): Check a story with a single agent, a graph and a swarm | Git, Node.js 22.19+, npm; uv for packaging |
| Review Session 3 | [Multi-agent systems slides](session-03-multi-agent-topologies/slides/session-03-multi-agent-topologies-2026-10-22.html) | A browser |

### Run your first app

The shortest path uses the minimal Python app. These commands copy its shared
font files into your project too:

```sh
git clone https://github.com/adityaarunsinghal/agentic-ai-workshop-2026.git
cd agentic-ai-workshop-2026
cp -RL session-01-agent-harnesses/examples/smallest-valid-app my-agent
cd my-agent
cp -n .env.example .env
```

Sign in to the [class app store](https://nyu-workshop.adityasinghal.com/) with
your approved Google address. Open **Account → Local development token**, choose
funding, model and a ceiling that meets the displayed minimum, then create a
token. Put its gateway and token in your private `.env` using a text editor.
You can start locally before uploading a ZIP or choosing an app address.

```sh
uv run --locked --env-file .env python app.py
```

Open `http://localhost:8080` and ask for the current UTC time. Requests use your
selected allowance. Stop the server with Ctrl+C. Keep the token private and
save its Token ID for revocation; stopping the server does not revoke it.

For a free scripted preview, use the HN harness's `npm run dev:fixture` instead.
Its [guide](session-01-agent-harnesses/demo-app/README.md) also explains workshop
funding and the optional use of your own OpenRouter account.

### Make it yours and publish

Change the tool and instructions in your chosen app, then try a complete task.
Start with a small useful version: a study coach, research assistant or project
planner. Each app's README identifies its editable files.

1. In **My app**, choose a unique address. Set the same `slug` in
   `workshop-app.json`, and write your own title, description and instructions.
2. Create a fresh ZIP with the app's packager. For the Python app above, if your
   claimed address is `my-agent`, run:

   ```sh
   uv run --locked python package.py --slug my-agent --output ../my-agent.zip
   ```

   For the HN app, follow its [packaging instructions](session-01-agent-harnesses/demo-app/README.md#create-a-fresh-upload-zip).
3. In **My app**, select your ZIP, choose **Publish ZIP**, and follow the build
   status. Open the published app and complete a task. For later updates, keep
   the slug and create a new ZIP for **Publish replacement ZIP**.

Use the packager's ZIP, with the manifest at its root. Keep `.env`, tokens,
local data and installed dependencies out of uploads. If packaging or launch
fails, start with [troubleshooting](session-01-agent-harnesses/TROUBLESHOOTING.md).

### Try classmates' agents and leave feedback

Open a classmate's project, try a task, and expand **Give feedback**. Select the
basis that matches what you did: **Used the app**, **Watched a demo**, or
**Read the project**. Describe what you tried, what worked, and one concrete
improvement, then select **Send feedback**.

### Demo day and course credit

**A version of your agent must be uploaded to the class platform for credit,
even if you demonstrate the full agent elsewhere.** A small working variant
that demonstrates your core idea is sufficient. Explain any simplifications
in its project description.

If you want to demonstrate your agent outside the app platform on demo day,
reply to one of Adi's workshop emails ahead of time to arrange it.

### Schedule and help

The [class webpage](https://adityasinghal.com/agentic-ai-workshop/) has the
schedule and announcements. The [Session 1 guide](session-01-agent-harnesses/README.md)
has the publication deadline and practice exercises.

Reply to a workshop email to reach **Adi Singhal**. For a technical issue,
include your project link, what you tried, the time and the exact error or
relevant build log. Remove tokens and private data before sharing.
