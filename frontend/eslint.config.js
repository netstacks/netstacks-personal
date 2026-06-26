import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // B-3: route diagnostic logging through src/lib/logger.ts so dev-only
      // `log`/`debug` lines drop out of production builds. `warn` and
      // `error` are intentionally still allowed via raw console — they
      // need to surface in prod for users / support.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // B-2: ban the inline `err instanceof Error ? err.message : '…'`
      // pattern. Use getErrorMessage(err) from api/errors.ts instead, which
      // is bytewise-equivalent and avoids re-deriving the same shape in
      // every catch block.
      'no-restricted-syntax': [
        'error',
        {
          selector: "ConditionalExpression[test.operator='instanceof'][test.right.name='Error'][consequent.type='MemberExpression'][consequent.property.name='message']",
          message: "Use getErrorMessage(err) from api/errors.ts instead of `err instanceof Error ? err.message : '…'`.",
        },
      ],
    },
  },
  // Exemptions: logger.ts itself wraps console.*; tests can use console
  // freely for debugging without polluting prod-build noise rules.
  {
    files: ['src/lib/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
])
