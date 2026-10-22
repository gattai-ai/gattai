import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { Web3Provider } from "@/providers/Web3Provider";
import { SessionProvider } from "@/lib/session";
import { RouterProvider } from "@/lib/router";
import { SiteErrorBoundary } from "@/site/SiteErrorBoundary";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SiteErrorBoundary>
      <Web3Provider>
        <SessionProvider>
          <RouterProvider>
            <App />
          </RouterProvider>
        </SessionProvider>
      </Web3Provider>
    </SiteErrorBoundary>
  </StrictMode>,
);
