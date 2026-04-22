// Flat ESLint config (W4-1). Covers TypeScript, React, JSX accessibility, and
// security-focused rules. Intentionally starts conservative — security rules
// are errors, style rules are warnings — so the CI `lint` job can ratchet up
// over time without forcing a single mega-PR.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import security from "eslint-plugin-security";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "backend/**",
      "public/**",
      "**/*.config.js",
      "**/*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
      security,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      // React
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off", // modern JSX transform
      "react/prop-types": "off", // TypeScript covers this

      // react-hooks v7 added several compiler-strict rules (set-state-in-effect,
      // immutability, purity, refs, globals, preserve-manual-memoization).
      // Demote to warn so the bump lands without a mass refactor — tighten later.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/globals": "warn",
      "react-hooks/preserve-manual-memoization": "warn",

      // Accessibility — warnings for now; promote to errors per page as fixed
      ...jsxA11y.configs.recommended.rules,
      "jsx-a11y/anchor-is-valid": "warn",
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",

      // Security — errors
      ...security.configs.recommended.rules,
      "security/detect-object-injection": "off", // too noisy with TS indexing
      "security/detect-non-literal-fs-filename": "off", // no fs access in browser

      // TypeScript — keep minor issues as warnings so legacy code still compiles
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",

      // Baseline hygiene
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    // Tests are allowed to use `any`, console, and non-null assertions freely.
    files: ["src/**/*.test.{ts,tsx}", "src/__tests__/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
      "security/detect-non-literal-regexp": "off",
    },
  },
];
