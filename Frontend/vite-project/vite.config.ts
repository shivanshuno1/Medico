import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In local dev, requests to /api/* are forwarded to the FastAPI backend
    // running on port 8000 (see Backend/main.py). This is what the comment
    // in ConsultChat.tsx referred to — it just wasn't actually configured.
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
