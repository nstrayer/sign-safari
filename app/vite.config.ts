import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  // Relative base keeps the build deployable at any subpath: GitHub Pages
  // serves it at /sign-safari/, local verification serves it at /docs/.
  base: "./",
  build: {
    // GitHub Pages serves main:/docs, so the committed build output lives
    // there. outDir is outside the Vite root, so emptying it must be opted
    // into; docs/ must never be hand-edited.
    outDir: "../docs",
    emptyOutDir: true,
  },
});
