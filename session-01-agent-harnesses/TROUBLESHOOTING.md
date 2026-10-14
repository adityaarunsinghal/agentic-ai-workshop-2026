## Local development and upload troubleshooting

First identify where it stopped: token setup, ZIP validation, dependency
installation, readiness or an action in the running app. A successful local
preview does not establish that the hosted build or inference will succeed.

### Connect locally

Use **Account → Local development token** in the class app store. Choose the
model, payer and ceiling there. The displayed gateway ends in `/api/development`.
Keep the token in the server's ignored `.env`, outside browser code and ZIPs.

| Symptom | What to do |
| --- | --- |
| No app uploaded yet | Account can prepare a basic inference policy. You can start locally without choosing an address or uploading source. |
| Ceiling rejected | Meet the selected model's displayed minimum reservation and stay within available funds. A reservation is a hold, not the final charge. Other active requests can reduce availability. |
| Bootstrap returns 401 | Check expiry or revocation. Create a replacement token when needed, update `.env`, and restart the local server. |
| An added service or storage scope is missing | Save the complete app policy in My app, then issue a new token. Existing tokens retain their original policy. |
| Model rejected | Use the model/profile selected by bootstrap. Changing a local model string does not change the token's policy. |
| Token disappeared after reload | The secret is shown only at issuance. Save its Token ID for revocation. Do not repeatedly create tokens after an uncertain response; contact Adi. |

Class-funded local and hosted requests share the same allowance. Creating
more tokens does not add credit. Personal funding charges the explicitly
selected personal account. Stop the local server and revoke an old token
separately; closing a page or clearing logs does neither.

The HN demo's free fixture uses scripted responses. Use a real mode to
evaluate prompt quality. The Python CLI harness uses your own capped
OpenRouter key; it is a small teaching loop without recovery or an app budget.

### Create a ZIP the platform can inspect

Use the chosen app's packaging command. Avoid compressing the entire project
with Finder. Check the printed archive path and upload that fresh file.

| Rejection | What to check |
| --- | --- |
| Wrong app address or `SLUG_MISMATCH` | `workshop-app.json.slug` must exactly match My app. The folder, display title and ZIP filename do not set that address. |
| Missing root files | The manifest and project/lock files belong at the ZIP root, without an enclosing project folder. |
| `LOCKFILE_MISMATCH` | After renaming a Node project or changing dependencies, run `npm install --package-lock-only`, then package again. Keep the package and lockfile together. |
| Python project/lock mismatch | Edit `pyproject.toml`, run `uv lock`, and retain `uv.lock`. The tiny CLI example instead has separate script lockfiles. |
| Credentials or macOS metadata | Remove `.env`, keys, local data, `__MACOSX` and `._*` entries. Use the packager. `.gitignore` does not control another ZIP tool. |
| Invalid `.env.example` | Keep credentials empty or obvious placeholders. Ordinary model names, limits and timeouts are allowed. Fix the reported line; do not paste real credentials into the example. |
| Undeclared root source in the HN packager | Add intended public source to `package-files.json`. Put private/generated work in `.local/`; do not include it merely to silence the check. |

The HN packager builds before writing the ZIP. Its `verify:package` command
installs, builds and tests that exact archive in a clean directory without
paid inference. The platform still performs its own Linux build and readiness
checks.

Do not remove lockfiles or edit isolated lockfile fields to bypass a check.
Repeated rejected uploads can consume the available attempts. Fix the cause
before retrying and use the quota reset time shown by the portal.

### Build and launch

For hosted execution, listen on `0.0.0.0`, honor the supplied `PORT`, and serve
the manifest's health path. A listener on `127.0.0.1` can pass a local probe
while remaining unreachable from the hosted network. Local preview listeners
can remain on loopback.

Readiness should start the server and health endpoint without paid inference
or external tool calls. Keep dependencies locked and use the Node/Python
version declared by the app.

If you add an API or MCP service, declare its destinations and capabilities
in the manifest, update the server adapter and configure credentials through
the documented connection path. A local token does not grant undeclared
network or service access to the hosted app.

### Recover from an interrupted action

The HN demo offers **Check status** and recovery for supported operations.
Use those before resubmitting. A timeout does not prove that the provider
stopped or that the attempt cost nothing. The minimal Python app does not
provide that recovery UI.

Avoid adding a second automatic retry loop around the broker. Keep one
operation ID and identical request bytes when recovering the same operation;
a new prompt is new work and can incur a new charge.

Page refresh, process restart and a new hosted visit have different effects.
Read your app's state notes. Clearing execution records does not clear saved
preferences, free a request slot or refund spending.

“The assigned worker assertion could not be verified” is a platform
authentication error. Send Adi the app link, time and exact message. Changing
the ZIP or pasting API keys is not a repair for that error.

### Ask for help

Reply to a workshop email with your app link, the action you took, the time,
the exact error and the relevant build log. Say whether it happened locally
or in a hosted visit. Remove tokens, private documents and account credentials.
Keep your original source and any useful partial work while investigating.
