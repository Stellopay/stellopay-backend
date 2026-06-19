import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "contracts/*.contract_class.json",
      "package-lock.json",
      "pnpm-lock.yaml",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
);
