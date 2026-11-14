import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The optional Presidio service (scripts/presidio_service.py) runs on 127.0.0.1:5055.
// The browser calls /api/*, and Vite forwards it, so there is no cross-origin request in development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5055",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
