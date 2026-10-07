## Agentic AI workshop 2026

Build an agent around an idea you care about, share it with the class, and learn
from trying each other's projects.

## [Class webpage: materials and schedule](https://adityasinghal.com/agentic-ai-workshop/)

Find the workshop schedule, teaching materials, and class announcements here.

## [Class app store: try, upload, and review agents](https://nyu-workshop.adityasinghal.com/)

Sign in with the Google address you provided for workshop access. Use the store
to try the class demos, publish your agent, and give classmates feedback.

## Clone and build your own agent

Install Git, Node.js 22.19 or newer, npm, and `zip`. Clone this repository and copy
the Session 1 starter into a folder for your own project:

```bash
git clone https://github.com/adityaarunsinghal/agentic-ai-workshop-2026.git
cd agentic-ai-workshop-2026
cp -R session-01-agent-harnesses/demo-app my-agent
cd my-agent
npm ci
```

Start with your own idea: a study coach, research assistant, project planner, or
something useful to you. Give it a concrete task and decide which tools it needs.

- `agent/app.mjs`: change the instructions, tools, user-preferences, and approvals.
- `agent/pi-mini.mjs`: read how the harness calls the model and executes tools.
- `agent/workshop.mjs`: connect inference, tools, and storage to your environment.
- `ui/`: adapt the interface to your agent's task.
- `workshop-app.json`: set your app's unique slug, title, description, and runtime
  requirements. Adjust the starter's HN-specific build checks if you change its
  declared services.

After making changes:

```bash
npm run build
npm start
```

Open `http://localhost:8080` to view the interface. The starter uses class-platform
services for inference and persistence; running it locally requires those
connections or a local adapter you implement. For independent local work, connect
your model adapter to OpenRouter and ask Adi about a custom key.

## Zip and upload

1. Open **My app** in the class app store and choose a unique app address.
   Put that same slug in `workshop-app.json`.
2. Build your app, then run this command from inside its folder:

   ```bash
   npm run build
   zip -r ../my-agent.zip . \
     -x "node_modules/*" ".git/*" ".env" ".env.*" \
        "log.md" "source-map.json" "*.zip" ".DS_Store"
   ```

   Keep `workshop-app.json` at the ZIP root. Include source, assets, licenses,
   `package.json`, and `package-lock.json`. Keep API keys and private data outside
   the ZIP.
3. In **My app**, choose your ZIP and select **Publish ZIP**. Follow the build
   status and complete any required connection settings.
4. Open the published project and try a complete task. Share its link with the
   class. For later changes, rebuild, create a fresh ZIP, and select
   **Publish replacement ZIP**.

## Try classmates' agents and leave feedback

Open a classmate's project, try a task, and expand **Give feedback**. Select the
basis that matches what you did: **Used the app**, **Watched a demo**, or
**Read the project**. Describe what you tried, what worked, and one concrete
improvement, then select **Send feedback**.

## Demo day and course credit

**A version of your agent must be uploaded to the class platform for credit,
even if you demonstrate the full agent elsewhere.** A small working variant
that demonstrates your core idea is sufficient. Explain any simplifications
in its project description.

If you want to demonstrate your agent outside the app platform on demo day,
reply to one of Adi's workshop emails ahead of time to arrange it.

## Questions, issues, and local OpenRouter access

Reply to one of the workshop emails you received after registering to reach
the instructor, **Adi Singhal**.

Contact Adi with questions, access or upload issues, or requests to demo outside
the platform. For a technical issue, include your project link, what you tried,
and the error message. You can also ask Adi for a custom OpenRouter key for local
development.
