import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    ignores: [
      'node_modules',
      'dist',
      '.wrangler',
      'site',
      // Build output and generated files are not source.
      'web/dist',
      'web/.wrangler',
      'web/node_modules',
      'web/src/routeTree.gen.ts',
      'web/worker-configuration.d.ts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // D-14: application code proves types instead of asserting them.
    // Vendored tiptap template code is excluded; `as const` stays allowed.
    files: ['web/src/**/*.ts', 'web/src/**/*.tsx'],
    ignores: ['web/src/components/tiptap-*/**', 'web/src/lib/tiptap-utils.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    // Node CLI scripts (web): Node globals, console allowed.
    files: ['**/scripts/**/*.mjs', '**/scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  }
);
