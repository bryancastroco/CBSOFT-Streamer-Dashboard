/**
 * Test-environment stand-in for the `server-only` package.
 *
 * The real package throws on import outside a React Server Component, which is
 * precisely the build-time guard we want in the application. Vitest is neither
 * a server nor a client bundle, so it resolves to the throwing entry point and
 * every server module becomes untestable.
 *
 * Aliasing it here restores testability without weakening anything: the guard
 * that matters runs during `next build`, which the verify pipeline still does.
 */
export {};
