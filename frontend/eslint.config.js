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
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Larang `x as unknown as T`: pola ini mematikan type-checker tepat di
      // titik yang paling butuh diperiksa (pernah menyembunyikan crash).
      // Gunakan assertion tunggal yang sebanding atau pengetikan eksplisit.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
          message: "Dilarang 'as unknown' di frontend. Tulis tipe yang sebanding atau tangani secara eksplisit.",
        },
      ],
    },
  },
])
