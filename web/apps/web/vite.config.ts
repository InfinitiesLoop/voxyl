import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // Three's WebGPU renderer uses top-level await; every browser we support has it.
    target: "es2023",
  },
});
