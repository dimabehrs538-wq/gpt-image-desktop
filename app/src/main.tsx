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
  // 移动端窄屏：提示显示在顶部标题栏下方，避免遮挡底部导航栏
  const mobile = window.matchMedia("(max-width: 767px)").matches;
  return <Toaster richColors closeButton position={mobile ? "top-center" : "bottom-right"} theme={resolvedTheme === "dark" ? "dark" : "light"}
    mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 56px)", left: 12, right: 12 }} />;
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
