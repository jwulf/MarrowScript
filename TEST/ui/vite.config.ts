import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// MarrowForge backend runs on localhost:3000 by default. The UI ships with a
// dev proxy so the browser doesn't need to think about CORS or hardcoded
// hosts in code — everything under /api is forwarded straight through.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.MARROWFORGE_BASE || "http://localhost:3000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
