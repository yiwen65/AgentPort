import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 2 expects port 1420 (strictPort) and a relative base so that the
// production bundle works under the tauri:// protocol.
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
