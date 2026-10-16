import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Node globals declared (`URL`, `fetch`, `AbortController`, `process`…), so
// CI fails where the editor would (plans/DISCORD.md §0.3, 5).
export default tseslint.config(
  {
    ignores: ["lib/**", "dist/**", "coverage/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/unbound-method": "off" },
  },
  {
    files: ["scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
);
