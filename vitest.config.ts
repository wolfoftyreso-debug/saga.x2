import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.cwd(),
  resolve: {
    alias: {
      "@": path.resolve(process.cwd()),
      "server-only": path.resolve(process.cwd(), "tests/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
