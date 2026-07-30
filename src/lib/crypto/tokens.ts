import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/config/env";

/**
 * Envelope encryption for Facebook Page access tokens.
 *
 * Architecture rules 4 and 5: Page tokens are stored encrypted and are never
 * returned to the browser, to Google Sheets, or to n8n. This module is the only
 * place a plaintext token may exist, and it is `server-only`.
 *
 * Format: AES-256-GCM, stored as a single opaque string.
 *
 *   v1.<base64url iv>.<base64url authTag>.<base64url ciphertext>
 *
 * The version prefix exists so a future key rotation can decrypt old records
 * while writing new ones in a newer format.
 */

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

function getKey(): Buffer {
  const { TOKEN_ENCRYPTION_KEY } = getServerEnv();

  const key = /^[0-9a-fA-F]{64}$/.test(TOKEN_ENCRYPTION_KEY)
    ? Buffer.from(TOKEN_ENCRYPTION_KEY, "hex")
    : Buffer.from(TOKEN_ENCRYPTION_KEY, "base64");

  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  return key;
}

/** Encrypt a plaintext Page token for storage in Postgres. */
export function encryptToken(plaintext: string): string {
  if (plaintext.length === 0) {
    throw new TokenCryptoError("Refusing to encrypt an empty token");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a stored Page token.
 *
 * Callers must treat the result as a secret with a very short lifetime: use it
 * for an outbound Meta Graph call on the server and drop it. Never log it,
 * never place it in a response body, never write it to a Sheet.
 */
export function decryptToken(encoded: string): string {
  const parts = encoded.split(".");

  if (parts.length !== 4) {
    throw new TokenCryptoError("Malformed encrypted token");
  }

  const [version, ivPart, tagPart, dataPart] = parts as [string, string, string, string];

  if (version !== VERSION) {
    throw new TokenCryptoError(`Unsupported encrypted token version: ${version}`);
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Do not surface the underlying crypto error — it can leak whether the
    // failure was a bad tag versus a bad key.
    throw new TokenCryptoError("Failed to decrypt token");
  }
}

/** How many bullets precede the visible suffix in a masked token. */
const MASK_BULLETS = 12;

/** The visible suffix length. Only ever the LAST four characters. */
const LAST_FOUR_LENGTH = 4;

/**
 * The last four characters of a plaintext token.
 *
 * This is the only fragment of a token that is persisted alongside the
 * ciphertext, and the only fragment permitted to reach a browser. Four
 * characters are a recognition aid for an operator comparing against the Meta
 * dashboard — not enough to be a credential.
 */
export function lastFourOf(plaintext: string): string {
  return plaintext.slice(-LAST_FOUR_LENGTH);
}

/**
 * Build the display form from the stored suffix alone: `••••••••••••ABCD`.
 *
 * Takes the suffix rather than the token on purpose. At render time the server
 * has only `page_token_last_four` loaded — it never decrypts a token in order
 * to display it, so there is no code path where a plaintext token exists just
 * to be masked.
 */
export function maskFromLastFour(lastFour: string | null | undefined): string {
  const bullets = "•".repeat(MASK_BULLETS);
  if (!lastFour) return bullets;
  return `${bullets}${lastFour.slice(-LAST_FOUR_LENGTH)}`;
}

/**
 * Mask a plaintext token directly, e.g. `••••••••••••9f2Q`.
 *
 * Used at the moment of ingestion, before the plaintext is discarded. Prefer
 * `maskFromLastFour` everywhere else.
 */
export function maskToken(plaintext: string): string {
  if (plaintext.length <= LAST_FOUR_LENGTH) return "•".repeat(MASK_BULLETS);
  return maskFromLastFour(lastFourOf(plaintext));
}

/** Constant-time comparison for secrets of arbitrary length. */
export function secureCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  // timingSafeEqual throws on length mismatch, so normalise length first.
  if (bufferA.length !== bufferB.length) {
    // Still perform a comparison so the failure path costs roughly the same.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}
