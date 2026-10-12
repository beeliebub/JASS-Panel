// Lint configuration: typed rules everywhere, accessibility and hook rules for the UI, and no Node in the UI.
import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const NO_DYNAMIC_IMPORT = {
  selector: "ImportExpression",
  message: "Use a static import; a dynamic import hides the dependency from the type checker and the bundle.",
};

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "web/dist/**", "coverage/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.web.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-syntax": ["error", NO_DYNAMIC_IMPORT],
    },
  },

  // The UI never sees Node and never injects HTML.
  {
    files: ["web/**/*.{ts,tsx}"],
    ...jsxA11y.flatConfigs.recommended,
    plugins: { ...jsxA11y.flatConfigs.recommended.plugins, "react-hooks": reactHooks },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:*", "**/src/server/**", "**/test/**"], message: "The UI imports only src/shared and the HTTP API." }] },
      ],
      "no-restricted-syntax": [
        "error",
        NO_DYNAMIC_IMPORT,
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Render untrusted content as text; do not inject HTML." },
      ],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },

  // Build scripts run under Node, outside any TypeScript project, and need its globals declared.
  {
    files: ["scripts/**/*.mjs", "test/support/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly", setInterval: "readonly" },
    },
  },

  // Plain JavaScript config files are not part of any TypeScript project.
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
