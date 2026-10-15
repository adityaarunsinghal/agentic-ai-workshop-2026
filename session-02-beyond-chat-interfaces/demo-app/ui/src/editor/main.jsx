import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Editor } from "./Editor.jsx";
import "../../style.css";
import "../../editor.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
createRoot(document.getElementById("root")).render(
  window.parent === window.self
    ? <main className="app-loading"><span className="identity-mark">E</span><h1>Interactive Editor View</h1><p>Open this MCP App from the workshop host.</p></main>
    : <QueryClientProvider client={queryClient}><Editor /></QueryClientProvider>,
);
