import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  envDir: fileURLToPath(new URL("../", import.meta.url)),
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
  },
});
