import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built assets land in web/dist and are served statically by the backend
// Express server (see src/server.ts). One box, one domain.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
});
