## Smallest valid app

Python 3.12, no dependencies. One UTC-time tool and a chat.
The portal supplies inference and pays from your selected allowance.
Chat has no application turn limit; platform visit and allowance limits apply.
Refresh retains chat. Ending the visit clears it.

Read `app.py` for the tool, agent loop and HTTP routes, `chat.js` for sending
and rendering messages, and `index.html` for the page and styles.

### Run locally

Install Git and uv, then clone the workshop repository:

```sh
git clone https://github.com/adityaarunsinghal/agentic-ai-workshop-2026.git
cd agentic-ai-workshop-2026/session-01-agent-harnesses/examples/smallest-valid-app
cp -n .env.example .env
```

If you already cloned the repository, enter this example's folder and run
only the copy command. It preserves an existing `.env`.

In the class app store, save your own app's `workshop-app.json` policy through
**My app**, then open **Account → Local development token**. Choose funding,
a model and a session ceiling, and create a token. Paste it into
`WORKSHOP_DEVELOPMENT_TOKEN` in `.env`. Use the gateway displayed by the store.
The `.env` file is gitignored; keep your token out of source files and messages.

From this folder, start the server:

```sh
uv run --locked --env-file .env python app.py
```

Open `http://localhost:8080` in your browser. The server uses the token's
selected model and funding through the development gateway. Chat requests
spend that session's allowance. Stop the server with Ctrl+C.
The token retains the app policy saved at issuance; create a new token after
changing that policy. Stopping the server does not revoke the token.

### Make it your own

For example, turn the time bot into a study coach that draws a practice exercise:

1. In `app.py`, change the system message in `history` to describe your coach's
   tone and behavior: ask what the learner is studying, draw an exercise when
   the topic is clear, and ask them to try it before giving the answer.
2. Replace `get_current_time()` with a `draw_exercise()` function that returns
   a practice exercise, such as “Explain the idea using one concrete example.”
   Update the tool description to explain what the new function does.
3. When renaming the tool, update all four places in `app.py`: its name in
   `tool_declaration`, its function definition, the name checked during tool-call
   validation, and the function called to produce `observation`.
   Keep its arguments empty for this first change.
4. In `index.html`, change the page title, heading, input placeholder and colors.
5. In `workshop-app.json`, set your claimed app slug, title, description and
   instructions. Update the README to describe your agent.

After Python changes, stop the server with Ctrl+C and rerun the start command.
Refresh the browser after HTML changes. Restarting the server clears chat history.
Try a request that should trigger your tool and check that a **TOOL** message
appears before the agent uses its result.

The system message guides behavior. `tool_declaration` tells the model what it
can call. The Python function executes the tool; its result goes back to the
model through the existing agent loop.

### Package for the portal

Copy the exact address from My app into `slug` in `workshop-app.json`.
For `smallest-valid-app`, use `"slug": "smallest-valid-app"`.
`smallest-possible-app` is a different address. Folder names, titles and ZIP
filenames can differ from the address.

From this folder, pass the address claimed in My app:

```sh
uv run --locked python package.py --slug smallest-valid-app \
  --output ~/Downloads/smallest-valid-app.zip
```

Upload that ZIP, launch it and ask **What is the current UTC time?**
The app uses the workshop broker and runs through the portal.

The packager rejects a different manifest slug before writing the ZIP.
The platform also checks the claimed address during ZIP inspection, before
running the build. A ZIP can pass file and lock checks and fail this address check.
For a ZIP-validation error, compare these addresses and read the reported reason.
The portal's Connections hint alone cannot identify the cause.

The ZIP dereferences the font symlinks. Montserrat uses `OFL.txt`.
