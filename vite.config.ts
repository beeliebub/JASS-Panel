import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The daemon substitutes the runtime base path for this placeholder when it serves index.html, so one static build works under
// whatever PANEL_BASE_PATH is configured.
//
// In development the daemon runs on 29200 and the real website (a local copy) on 3000: Vite proxies the panel API to the daemon
// and sign-in to the website, so the browser keeps one origin and the session cookie is the website's own.
export default defineConfig(({ command }) => ({
  root: "web",
  base: command === "serve" ? "/panel/" : "/__PANEL_BASE__/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  resolve: { alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/panel/api": { target: "http://127.0.0.1:29200" },
      "/login": { target: "http://127.0.0.1:3000" },
      "/api/auth": { target: "http://127.0.0.1:3000" },
    },
  },
}));
