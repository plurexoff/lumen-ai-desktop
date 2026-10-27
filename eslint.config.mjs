import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Generated / vendored output is never linted.
  { ignores: ['dist/**', 'dist-electron/**', 'dist-cli/**', 'release/**', 'node_modules/**', 'build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['electron/**/*.ts', 'cli/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      // Empty catch blocks are an intentional pattern here (best-effort cleanup
      // paths, e.g. ROLLBACK on an already-broken connection or quarantine fallback).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The React-compiler-era rules flag deliberate patterns in this codebase:
      // ref mirrors that keep callback identities stable (App.draftRef,
      // variantsRef) and throttled markdown parsing that must set state from an
      // effect (useMarkdown). They are documented in the code; refactoring them
      // would risk the streaming hot path for no user-visible gain.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
    },
  },
);
