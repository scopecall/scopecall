import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    register: "src/register.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  define: {
    __SDK_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
  },
  // Inline JSON files into the bundle — eliminates ESM import attribute requirement
  loader: { ".json": "json" },
});
