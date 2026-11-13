import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    // One file at a time: the opt-in Solr files each make a collection of
    // their own on one SolrCloud, which a single test machine shares.
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
