import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    server: {
      deps: {
        // agent-runtimes' lib/portable keeps tsc's extensionless relative
        // imports: in a standalone clone it sits in node_modules, where Node
        // would load it as is and fail; transformed by Vite, it resolves
        // (plans/DISCORD.md §4.2). In the monorepo the workspace link already
        // points outside node_modules.
        inline: ["@datalayer/agent-runtimes"],
      },
    },
  },
});
