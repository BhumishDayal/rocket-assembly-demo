import { defineConfig } from "vite";

// Relative base so the build works on GitHub Pages (/repo/) and any static host.
export default defineConfig({
  base: "./",
  build: { target: "es2020", sourcemap: false },
});
