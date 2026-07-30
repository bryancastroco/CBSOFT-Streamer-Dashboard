/**
 * Refusing Page token material on the way IN — a PURE module.
 *
 * The specification says these endpoints must never *accept* a Page token, which
 * is a different requirement from never returning one and needs its own
 * mechanism.
 *
 * ## Why it matters
 *
 * n8n has no legitimate reason to hold a Page token, and the whole architecture
 * exists so it never does (rules 3 and 5). But "n8n does not have one" is a
 * property of how n8n is configured, and configurations drift: somebody
 * debugging a Graph call pastes a token into a workflow parameter, the workflow
 * posts it here, and now a credential that was supposed to live only as
 * ciphertext in one column is sitting in an n8n execution log, a proxy log and
 * this application's request log.
 *
 * Rejecting the request at the door makes that mistake loud and immediate rather
 * than silent and permanent. The endpoint responds `400` naming the offending
 * field — never echoing the value.
 *
 * ## What counts as token material
 *
 * Two independent signals, because either alone misses cases:
 *
 * 1. **A suspicious key**, at any depth: `access_token`, `page_token`, and so
 *    on. Catches a token even when the value looks unremarkable.
 * 2. **A suspicious value**: a Meta user/page token (`EAA…`), or this
 *    application's own `v1.<iv>.<tag>.<ciphertext>` envelope. Catches a token
 *    smuggled under an innocent key like `note` or `data`.
 */

/** Key fragments that indicate a credential, matched case-insensitively. */
const SUSPICIOUS_KEY_PATTERNS = [
  "access_token",
  "accesstoken",
  "page_token",
  "pagetoken",
  "page_access",
  "pageaccess",
  "client_secret",
  "clientsecret",
  "app_secret",
  "appsecret",
  "authorization",
  "bearer_token",
  "encrypted_page_token",
  "encryptedpagetoken",
];

/**
 * Value shapes that are credentials.
 *
 * `EAA…` is the prefix every Meta user and Page access token carries; the length
 * floor keeps it from firing on ordinary prose that happens to start that way.
 * `v<n>.` is this application's own crypto envelope — a request carrying one
 * means somebody has read the ciphertext column, which is worth refusing loudly.
 */
const SUSPICIOUS_VALUE_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bEAA[A-Za-z0-9_-]{20,}/, label: "a Meta access token" },
  {
    pattern: /\bv[0-9]+\.[A-Za-z0-9+/=_-]{16,}\.[A-Za-z0-9+/=_-]{16,}\./,
    label: "encrypted token ciphertext",
  },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, label: "a JSON Web Token" },
];

export type TokenMaterialFinding = {
  /** Dotted path to the offending field, e.g. `streamers.0.token`. */
  path: string;
  /** Why it was refused. Never contains the value itself. */
  reason: string;
};

/** Depth cap, so a hostile deeply-nested body cannot exhaust the stack. */
const MAX_DEPTH = 8;

function keyLooksLikeCredential(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[\s-]/g, "_");

  if (SUSPICIOUS_KEY_PATTERNS.some((pattern) => normalised.includes(pattern))) return true;

  // A bare `token` or `secret` field, but not `token_status` or `tokens_used`,
  // which are legitimate metadata names that say nothing secret.
  return /^(token|secret|credential|password|passwd|api_key|apikey)$/.test(normalised);
}

function valueLooksLikeCredential(value: string): string | null {
  for (const { pattern, label } of SUSPICIOUS_VALUE_PATTERNS) {
    if (pattern.test(value)) return label;
  }
  return null;
}

/**
 * Walk a parsed request body looking for credential material.
 *
 * Returns every finding rather than the first, so a caller fixing their workflow
 * is told about all of it in one response instead of discovering the next one on
 * the next attempt.
 */
export function findTokenMaterial(body: unknown, path = "", depth = 0): TokenMaterialFinding[] {
  if (depth > MAX_DEPTH) return [];

  if (typeof body === "string") {
    const label = valueLooksLikeCredential(body);
    return label ? [{ path: path || "(body)", reason: `The value looks like ${label}.` }] : [];
  }

  if (Array.isArray(body)) {
    return body.flatMap((entry, index) =>
      findTokenMaterial(entry, path ? `${path}.${index}` : String(index), depth + 1),
    );
  }

  if (body !== null && typeof body === "object") {
    const findings: TokenMaterialFinding[] = [];

    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;

      if (keyLooksLikeCredential(key)) {
        findings.push({
          path: childPath,
          reason:
            "This field name is reserved for credentials, which these endpoints never accept.",
        });
        // Do not also scan the value — one finding per field is enough, and
        // reporting twice would suggest two separate problems.
        continue;
      }

      findings.push(...findTokenMaterial(value, childPath, depth + 1));
    }

    return findings;
  }

  return [];
}

export function containsTokenMaterial(body: unknown): boolean {
  return findTokenMaterial(body).length > 0;
}
