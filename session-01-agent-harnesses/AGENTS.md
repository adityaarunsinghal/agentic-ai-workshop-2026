## Working on a workshop project

Read the chosen project's README before editing. Each example is independent;
run its commands from its own directory.

- The HN app uses `demo-app/agent/app.mjs` for instructions, tools and approvals,
  `agent/pi-mini.mjs` for the loop, and `ui/main.mjs` for authored browser code.
  `ui/browser.mjs` and `source-map.json` are generated files.
- The minimal Python app uses `examples/smallest-valid-app/app.py` for its tool,
  loop and routes. Update its tool declaration, validation and execution
  together when changing the tool.
- Keep dependency declarations and lockfiles together. Use npm or uv to update
  locks. Match `workshop-app.json.slug` to the address claimed in My app.
- Keep tokens in server-side environment configuration. Preserve `.env.example`
  with empty credentials. Do not put credentials, local state or logs in ZIPs.
- Declare required hosted services and network destinations. Keep the hosted
  listener reachable on `0.0.0.0`, honor `PORT`, and keep readiness free of paid
  inference or external tool calls.
- Retain bootstrap's model, profile and payer. Let the broker own retries.
  Do not silently change funding, drop context or bypass failed validation.
- Label fixtures as scripted. Preserve completed tool observations, partial
  work and recovery IDs. Display formatting must not change model inputs.
- HN checks: `npm ci`, `npm test`, `npm run verify:sources`,
  `npm run package:workshop`, then `npm run verify:package -- --zip PATH`.
- Minimal Python checks: `uv run --locked python -m unittest -v`, then
  `uv run --locked python package.py --slug YOUR_ADDRESS --output PATH.zip`.
- The CLI harness's `uv run --locked check-tools.py` checks its tool without
  inference. Its full loop uses the separately configured provider account.
- Report which checks ran. Fixture success, a local build and hosted
  publication establish different things. Paid calls and publication require
  the project owner's approval.
