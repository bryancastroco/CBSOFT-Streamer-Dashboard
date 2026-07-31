import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      /*
       * The TypeScript-aware variant, so `allowTypeImports` is available.
       *
       * A `import type { PostTableItem } from "@/lib/repositories/posts"` is
       * erased at compile time — it pulls no code into the client bundle and
       * cannot reach a secret. Banning it would force the row shapes to be
       * duplicated somewhere neutral, and two definitions of the same row is a
       * worse outcome than the import. Value imports stay banned.
       */
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              allowTypeImports: true,
              group: [
                "@/lib/crypto/*",
                // NOT @/lib/meta/* — `token-status` is deliberately pure and
                // shareable (labels, badge tones, health derivation). Only the
                // modules that hold a token or a secret are restricted.
                "@/lib/meta/graph",
                "@/lib/meta/token-validation",
                "@/lib/db/*",
                "@/lib/audit/log",
                "@/lib/repositories/*",
                "@/lib/auth/guards",
                "@/lib/auth/session",
                "@/config/env",
              ],
              message:
                "Server-only module. Import it from a Server Component, Route Handler or Server Action — never from a Client Component.",
            },
          ],
        },
      ],
    },
  },

  /*
   * Server-only modules may import each other freely.
   *
   * An allow-list rather than a deny-list: a new file under src/components or
   * src/app that is a Client Component is covered by default, and adding a
   * directory here is a conscious act.
   *
   * Server Components under src/app/(app) are NOT listed — they import through
   * repositories, and `server-only` plus the Next.js compiler is the real
   * enforcement. This rule is the early, readable warning.
   */
  {
    files: [
      "src/lib/crypto/**",
      "src/lib/meta/**",
      "src/lib/db/**",
      "src/lib/security/**",
      "src/lib/ai/**",
      "src/lib/google-sheets/**",
      "src/lib/audit/**",
      "src/lib/repositories/**",
      "src/lib/services/**",
      // The automation surface is server-only by construction: `guard.ts` and
      // `export-handler.ts` both import `server-only`, and nothing under
      // src/components or src/app(client) imports from here.
      "src/lib/automation/**",
      "src/lib/observability/**",
      /*
       * `settings-view.ts` reads configuration to describe it on the admin
       * screens, and imports `server-only` so it cannot be pulled into a client
       * bundle. It also never puts a secret in its output — a credential
       * becomes `present: true`, and there is no path back to the string. The
       * bundle scan in `tests/bundle-secrets.test.ts` is the backstop.
       */
      "src/lib/config/**",
      "src/lib/auth/**",
      "src/lib/supabase/**",
      "src/lib/api/**",
      "src/lib/validation/**",
      "src/app/api/**",
      "src/app/**/page.tsx",
      "src/app/**/layout.tsx",
      "src/app/**/actions.ts",
      "src/middleware.ts",
      "src/config/env.ts",
      "drizzle.config.ts",
      "scripts/**",
      "tests/**",
    ],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },

  // shadcn/ui primitives are vendored code — keep them lint-clean but unopinionated.
  {
    files: ["src/components/ui/**"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },

  // Tests use `vi.importActual<typeof import("…")>`, which is the idiomatic
  // way to keep a real class for `instanceof` while mocking its module.
  {
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },

  // Prettier must stay last so it can disable stylistic rules.
  prettier,

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "drizzle/**",
    "node_modules/**",
  ]),
]);

export default eslintConfig;
