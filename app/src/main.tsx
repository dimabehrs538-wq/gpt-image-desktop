import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "sonner";
import App from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DataProvider } from "@/lib/store";
import { UpdaterProvider } from "@/lib/updater";
import "./index.css";

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster richColors position="bottom-right" closeButton theme={resolvedTheme === "dark" ? "dark" : "light"} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <DataProvider>
          <UpdaterProvider>
            <App />
          </UpdaterProvider>
        </DataProvider>
        <ThemedToaster />
      </TooltipProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
