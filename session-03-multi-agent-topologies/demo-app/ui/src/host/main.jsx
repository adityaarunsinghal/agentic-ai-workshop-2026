import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Host } from "./Host.jsx";
import "../../style.css";
import "../../host.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={queryClient}><Host /></QueryClientProvider>,
);
