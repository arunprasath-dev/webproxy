import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  outDir: "dist",
  // Copy static web assets next to the bundled server so readFileSync(import.meta.url) resolves.
  onSuccess: "rm -rf dist/web && cp -r src/web dist/web",
});
