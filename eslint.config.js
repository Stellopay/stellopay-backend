import tseslint from "typescript-eslint";

const nodeGlobals = {
  Buffer: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
};

export default [
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "no-undef": "off",
    },
  },
  {
    files: ["src/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: nodeGlobals,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-console": "off",
    },
  },
  {
    files: [
      "src/index.ts",
      "src/middleware/access-log.ts",
      "src/routes/auth.ts",
      "src/utils/cors.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "no-console": "off",
    },
  },
];
