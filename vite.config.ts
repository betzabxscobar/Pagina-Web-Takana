import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { servirUnityWebGL } from "./server/unity-webgl.mjs";

export default defineConfig({
  plugins: [
    react(),
    {
      // El juego se sirve desde public/takablox y viene comprimido en Brotli.
      // Sin Content-Encoding el navegador no lo descomprime y Unity no arranca.
      name: "takablox-webgl",
      configureServer(server) {
        server.middlewares.use(servirUnityWebGL);
      },
      configurePreviewServer(server) {
        server.middlewares.use(servirUnityWebGL);
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 3100,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3101",
    },
  },
});
