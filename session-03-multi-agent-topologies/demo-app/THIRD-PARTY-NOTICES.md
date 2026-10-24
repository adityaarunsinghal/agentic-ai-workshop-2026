## Third-party notices

- **Pi 1.0.0**, Copyright (c) 2025 Mario Zechner, MIT. Complete selected source
  files and the original license are retained under `reference/pi-1.0.0/`.
  These files are historical comparison material. The runtime uses the published
  Pi Agent Core and Pi AI libraries rather than the earlier miniature adaptation.
- **Montserrat**, SIL Open Font License 1.1. Original font and license bytes
  are retained as `ui/fonts/montserrat.woff2` and `ui/fonts/OFL.txt`.
- **MCP Apps**, Apache-2.0. The official SDK and sandbox proxy pattern are used;
  the proxy attribution is retained under `ui/licenses/`.
- **highlight.js 11.12.0**, BSD-3-Clause. Syntax colors use its public API;
  the license is retained in `ui/licenses/highlight.js-LICENSE.txt`.
- **CodeMirror**, MIT. The JSON input uses its editor and language packages,
  without a linting extension. Their exact versions are locked.
- **markdown-it 15.0.2**, MIT. Markdown/code rendering disables raw HTML.
- Runtime dependencies are locked in `package-lock.json`. Their package
  distributions include their license notices. Public interfaces supply the
  agent loop, provider parsing, MCP transport/Apps bridge, React UI, draggable
  editing, query cache, inspection, and source parsing.
- The principal libraries are Pi Agent Core/AI, MCP SDK/ext-apps, React,
  Radix Primitives, react-rnd, TanStack Query, Hono, Readability, jsdom, rss-parser,
  html-to-text, undici, and Google News URL decoder.

The original Pi files are reference inputs. Formatting and source-navigation
generation preserve their exact bytes.
