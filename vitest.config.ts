import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    // One file at a time: the PostgreSQL files share one throwaway database,
    // which migrate.test.ts drops and remakes.
    fileParallelism: false,
    server: {
      deps: {
        // agent-runtimes' lib/portable keeps tsc's extensionless relative
        // imports: in a standalone clone it sits in node_modules, where Node
        // would load it as is and fail; transformed by Vite, it resolves.
        // In the monorepo the workspace link already
        // points outside node_modules.
        inline: ["@datalayer/agent-runtimes"],
      },
    },
  },
});
