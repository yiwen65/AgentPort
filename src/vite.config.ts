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
  // Vitest augments the Vite config at runtime. Spread the optional block so
  // this file type-checks with Vite alone as well as with Vitest installed.
  ...({ test: { environment: "jsdom", globals: true } } as Record<string, unknown>),
});
