import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  // Relative base keeps the build deployable at any subpath: GitHub Pages
  // serves it at /sign-safari/, local verification serves it at /docs/.
  base: "./",
  build: {
    // docs/ is gitignored build output; the Pages deploy workflow uploads
    // it as the site artifact. outDir is outside the Vite root, so emptying
    // it must be opted into.
    outDir: "../docs",
    emptyOutDir: true,
  },
});
