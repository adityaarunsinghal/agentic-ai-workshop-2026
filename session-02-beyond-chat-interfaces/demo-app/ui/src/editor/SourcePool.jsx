import React, { useState } from "react";
import { safeHttpUrl } from "../shared/state.mjs";
import { Popover, PopoverClose } from "../shared/Popover.jsx";

export function SourcePool({ sources, controller, onInspect }) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("web");
  const [filter, setFilter] = useState("all");
  const [searching, setSearching] = useState(false);
  const kinds = [...new Set(sources.map((source) => source.kind || "source"))];
  const visible = sources.filter((source) => filter === "all" || (source.kind || "source") === filter);
  async function search(event) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const name = { web: "search_web", hn: "search_hn", news: "search_google_news", url: "fetch_read" }[provider];
      await controller.run(name, provider === "url" ? { url: query.trim() } : { query: query.trim() });
    } finally { setSearching(false); }
  }
  return (
    <aside className="source-pool" aria-label="Sources">
      <div className="section-head source-pool-header"><h2>Sources</h2><span className="count-badge">{sources.length}</span></div>
      <form className="source-search" onSubmit={search}>
        <div className="source-searchbar">
          <input id="source-query" value={query} onChange={(event) => setQuery(event.target.value)}
            aria-label={provider === "url" ? "Article URL" : "Search sources"}
            placeholder={provider === "url" ? "Paste a link…" : `Search ${{ web: "the Web", hn: "Hacker News", news: "Google News" }[provider]}…`} type={provider === "url" ? "url" : "search"}
            required maxLength={provider === "url" ? 2048 : 300} />
          <button type="submit" className="quiet icon-button"
            aria-label={searching ? "Searching" : provider === "url" ? "Read URL" : "Search sources"}
            title={provider === "url" ? "Read URL" : "Search"}
            disabled={searching || !query.trim() || !controller.connection.isConnected}>
            {searching ? "…" : "↗"}
          </button>
        </div>
        <details className="source-options">
          <summary>Search options</summary>
          <div className="source-options-fields">
            <label>Search in
              <select value={provider} onChange={(event) => setProvider(event.target.value)} aria-label="Research source">
                <option value="web">Web</option><option value="hn">Hacker News</option><option value="news">Google News</option><option value="url">Read a URL</option>
              </select>
            </label>
            {kinds.length > 1 && <label>Show
              <select className="source-filter" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter sources">
                <option value="all">All sources</option>{kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>}
          </div>
        </details>
      </form>
      <ol className="source-cards">
        {visible.map((source) => {
          const url = safeHttpUrl(source.canonicalUrl || source.url);
          return (
            <li className="source-card" key={source.id}>
              <button className="source-card-open" type="button" onClick={() => onInspect(source, source.title)}>
                <span className="source-card-content">
                  <strong>{source.title}</strong>
                  {url && <span className="source-host">{url.hostname}</span>}
                </span>
              </button>
              <div className="source-actions">
                <Popover label="Source actions" className="source-menu-actions"
                  trigger={<button type="button" className="text-button icon-button" aria-label={`More actions for ${source.title}`} title="More actions">⋯</button>}>
                  <PopoverClose asChild><button type="button" className="text-button" onClick={() => controller.run("save_reading_list", { sourceIds: [source.id] })}>Save link</button></PopoverClose>
                  <PopoverClose asChild><button type="button" className="text-button" onClick={() => onInspect(source, source.title)}>Inspect source</button></PopoverClose>
                  {url && <PopoverClose asChild><button type="button" className="text-button" onClick={() => controller.openLink(url.href)}>Open original ↗</button></PopoverClose>}
                </Popover>
              </div>
            </li>
          );
        })}
      </ol>
      {!visible.length && <p className="pool-empty">Search or add a link.</p>}
    </aside>
  );
}
