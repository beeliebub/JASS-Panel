import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          // Unit tests sit beside their modules; integration tests live under test/.
          restoreMocks: true,
          testTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          environment: "happy-dom",
          include: ["web/**/*.test.tsx"],
          restoreMocks: true,
          testTimeout: 15_000,
        },
      },
    ],
  },
});
