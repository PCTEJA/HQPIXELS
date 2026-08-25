import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      '.wrangler/**',
      'playwright-report/**',
      'test-results/**',
      'worker/worker-env.d.ts',
      'supabase/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // --- Security guardrails enforced by lint, not by review discipline ----
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'eval', message: 'Never evaluate strings as code.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          property: 'innerHTML',
          message: 'Assigning innerHTML is an XSS sink. Set textContent instead.',
        },
        {
          property: 'outerHTML',
          message: 'Assigning outerHTML is an XSS sink.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'dangerouslySetInnerHTML is forbidden. All buyer-supplied text renders as text nodes.',
        },
        {
          selector:
            'CallExpression[callee.object.name="Math"][callee.property.name="round"] > BinaryExpression[operator="*"]',
          message:
            'Suspicious float money math. Prices are integer cents — use the helpers in shared/pricing.ts.',
        },
      ],
    },
  },

  // ---- Client -----------------------------------------------------------------
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // The client must never hold a privileged token.
      'no-restricted-properties': [
        'error',
        {
          object: 'localStorage',
          property: 'setItem',
          message:
            'Do not persist auth state in localStorage. Sessions live in HttpOnly cookies set by the Worker.',
        },
        {
          property: 'innerHTML',
          message: 'Assigning innerHTML is an XSS sink. Set textContent instead.',
        },
      ],
    },
  },

  // ---- Worker -----------------------------------------------------------------
  {
    files: ['worker/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      // The Worker's structured logger redacts; raw console.log can leak.
      'no-console': 'error',
    },
  },

  // ---- Tests / tooling --------------------------------------------------------
  {
    files: ['tests/**/*.ts', 'scripts/**/*.{ts,mjs}', '*.config.ts', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-console': 'off',
    },
  },
);
