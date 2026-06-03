/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  rules: {
    // snake_case is intentional in src/wire/ (wire DTO matches API contract)
    "@typescript-eslint/naming-convention": [
      "error",
      {
        selector: "default",
        format: ["camelCase"],
        leadingUnderscore: "allow",
      },
      {
        selector: "variable",
        format: ["camelCase", "UPPER_CASE", "PascalCase"],
        leadingUnderscore: "allow",
      },
      {
        selector: "typeLike",
        format: ["PascalCase"],
      },
      // Disable naming rules for object literal properties — wire DTO uses snake_case
      {
        selector: "objectLiteralProperty",
        format: null,
      },
      {
        selector: "typeProperty",
        format: null,
      },
    ],
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-console": "off",
  },
  env: {
    node: true,
    es2022: true,
  },
};
