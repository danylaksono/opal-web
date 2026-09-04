import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import "@/app/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary label="Opal Web">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
