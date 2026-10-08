## Smallest valid app

Python 3.12, no dependencies. One UTC-time tool and a chat.
The portal supplies inference and pays from your selected allowance.
Chat has no application turn limit; platform visit and allowance limits apply.
Refresh retains chat. Ending the visit clears it.

Read `app.py` for the tool, agent loop and HTTP routes, `chat.js` for sending
and rendering messages, and `index.html` for the page and styles.

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
