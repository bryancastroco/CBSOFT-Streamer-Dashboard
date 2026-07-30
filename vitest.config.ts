import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Honours the `@/*` paths from tsconfig.json.
    tsconfigPaths: true,
    alias: {
      // See tests/stubs/server-only.ts for why this alias exists.
      "server-only": path.resolve(here, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Populates a complete, throwaway server environment before any import.
    setupFiles: ["tests/setup/env.ts"],
    // The migration suite boots an in-process Postgres; give it room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
