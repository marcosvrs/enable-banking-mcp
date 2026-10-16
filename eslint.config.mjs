import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const forTypeScript = (configs) =>
  configs.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx,mts,cts}"],
  }));

export default defineConfig([
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**", "reports/**"],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  js.configs.recommended,
  ...forTypeScript(tseslint.configs.strictTypeChecked),
  ...forTypeScript(tseslint.configs.stylisticTypeChecked),
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true } },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      "@typescript-eslint/no-invalid-void-type": [
        "error",
        { allowInGenericTypeArguments: true },
      ],
    },
  },
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx,cts,mts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.{ts,tsx,cts,mts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
]);
