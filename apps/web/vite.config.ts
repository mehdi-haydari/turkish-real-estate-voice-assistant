import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api/stt": {
          target: env.STT_SERVICE_URL || "http://127.0.0.1:8766",
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/api\/stt/, ""),
        },
        "/api/llm": {
          target: env.LLM_SERVICE_URL || "http://127.0.0.1:8768",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/llm/, ""),
        },
        "/api/tts": {
          target: env.TTS_SERVICE_URL || "http://127.0.0.1:8770",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/tts/, ""),
        },
        "/api/portfolio": {
          target: env.PORTFOLIO_SERVICE_URL || "http://127.0.0.1:8769",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/portfolio/, ""),
        },
      },
    },
  };
});
