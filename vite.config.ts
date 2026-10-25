import { defineConfig } from "vite"

// The packaged overlay loads dist/index.html from disk, so asset paths must be relative.
export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 4000 } // mermaid is large; it loads from disk, not the network
})
