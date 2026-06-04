// Minimal flat ESLint config for first-party code. Rules start at "warn" so the
// existing baseline is visible without blocking work; tighten to "error" once
// the baseline is burned down. Vendored/module code is not linted (not tracked
// in this repo). See CLAUDE.md "Code Style".
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "web-admin/backend/public/**",
      ".modules/**",
      "**/dist/**",
    ],
  },
  js.configs.recommended,
  {
    // First-party Node code — every first-party package.json is "type": "module".
    files: [
      "web-admin/backend/src/**/*.js",
      "scripts/**/*.js",
      "actual-budget-sync/**/*.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-prototype-builtins": "off",
    },
  },
  {
    // React frontend (Vite, new JSX transform).
    files: ["web-admin/frontend/src/**/*.{js,jsx}"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "no-unused-vars": "warn",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // Escaping apostrophes/quotes in JSX text is pedantic noise, not a bug.
      "react/no-unescaped-entities": "off",
    },
  },
  {
    // Baseline starts at "warn" so pre-existing smells are visible without
    // blocking commits. Tighten to "error" once the baseline is burned down.
    rules: {
      "no-useless-catch": "warn",
    },
  },
];
