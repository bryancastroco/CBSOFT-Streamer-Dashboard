"use client";

/**
 * The last-resort boundary: a failure in the root layout itself.
 *
 * It has to render its own `<html>` and `<body>` because the layout that
 * normally provides them is what failed. That also means no Tailwind-driven
 * theme variables and no fonts are guaranteed here, so the styling is inline and
 * deliberately plain — this screen's only job is to not be a blank page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          margin: 0,
          padding: "2rem",
        }}
      >
        <main style={{ maxWidth: "32rem" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
            The dashboard failed to start
          </h1>
          <p style={{ color: "#666", fontSize: "0.875rem", lineHeight: 1.6 }}>
            Something went wrong before the page could be rendered. Reloading usually clears it. If
            it does not, the server logs will carry the detail.
          </p>
          {error.digest ? (
            <p style={{ color: "#666", fontFamily: "monospace", fontSize: "0.75rem" }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 0.875rem",
              fontSize: "0.875rem",
              borderRadius: "0.5rem",
              border: "1px solid #ccc",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
