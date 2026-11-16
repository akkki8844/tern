/** Root ESLint configuration for every TypeScript package (apps/web adds Next rules). */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { es2022: true, node: true },
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-non-null-assertion": "off",
    "no-console": ["error", { allow: ["error"] }],
    eqeqeq: ["error", "smart"],
    "no-restricted-syntax": [
      "error",
      {
        // Configuration is the only module allowed to read the environment.
        selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
        message: "Read configuration through @capibara/shared's getConfig() instead of process.env."
      }
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "child_process", message: "Use @capibara/sandbox's runProcess, which enforces argv-only execution." },
          { name: "node:child_process", message: "Use @capibara/sandbox's runProcess, which enforces argv-only execution." }
        ]
      }
    ]
  },
  overrides: [
    {
      files: ["**/*.test.ts", "**/testing/**/*.ts", "scripts/**/*.ts", "**/scripts/**/*.ts", "demo/**/*.ts", "packages/db/prisma/seed.ts"],
      rules: { "no-console": "off", "no-restricted-syntax": "off", "@typescript-eslint/no-explicit-any": "off" }
    },
    {
      // The configuration module and the sandbox executor are the sanctioned exceptions.
      files: ["packages/shared/src/config.ts", "packages/shared/src/logger.ts", "packages/sandbox/src/process-executor.ts"],
      rules: { "no-restricted-syntax": "off", "no-restricted-imports": "off" }
    }
  ],
  ignorePatterns: [
    "node_modules",
    "dist",
    ".next",
    "apps/web",
    "**/*.d.ts",
    "packages/db/prisma/client",
    "demo/broken-app"
  ]
};
