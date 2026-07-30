import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TokenCryptoError,
  decryptToken,
  encryptToken,
  lastFourOf,
  maskFromLastFour,
  maskToken,
  secureCompare,
} from "@/lib/crypto/tokens";

/** Shaped like a real Page token, but not one. */
const TOKEN = "EAABwzLixnjYBO1ZCfakepagetokenforunittests9f2Q";

describe("token encryption", () => {
  it("round-trips a token", () => {
    expect(decryptToken(encryptToken(TOKEN))).toBe(TOKEN);
  });

  it("produces a versioned envelope", () => {
    expect(encryptToken(TOKEN)).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("never leaves the plaintext visible in the ciphertext", () => {
    const sealed = encryptToken(TOKEN);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain(TOKEN.slice(0, 12));
  });

  it("uses a fresh nonce, so the same token encrypts differently each time", () => {
    // Deterministic ciphertext would let anyone with database access tell that
    // two streamers share a token.
    expect(encryptToken(TOKEN)).not.toBe(encryptToken(TOKEN));
  });

  it("round-trips tokens of awkward lengths", () => {
    for (const value of ["a", "ab".repeat(500), "unicode-✓-token-Ω"]) {
      expect(decryptToken(encryptToken(value))).toBe(value);
    }
  });

  it("refuses to encrypt an empty token", () => {
    expect(() => encryptToken("")).toThrow(TokenCryptoError);
  });

  it("rejects tampered ciphertext", () => {
    const parts = encryptToken(TOKEN).split(".");
    const payload = Buffer.from(parts[3]!, "base64url");
    payload[0] = (payload[0] ?? 0) ^ 0xff;

    const tampered = [parts[0], parts[1], parts[2], payload.toString("base64url")].join(".");

    expect(() => decryptToken(tampered)).toThrow(TokenCryptoError);
  });

  it("rejects a tampered auth tag", () => {
    const parts = encryptToken(TOKEN).split(".");
    const tag = Buffer.from(parts[2]!, "base64url");
    tag[0] = (tag[0] ?? 0) ^ 0xff;

    const tampered = [parts[0], parts[1], tag.toString("base64url"), parts[3]].join(".");

    expect(() => decryptToken(tampered)).toThrow(TokenCryptoError);
  });

  it("rejects a malformed envelope", () => {
    for (const bad of ["", "notatoken", "v1.only.three", "v1.a.b.c.d"]) {
      expect(() => decryptToken(bad)).toThrow(TokenCryptoError);
    }
  });

  it("rejects an unsupported envelope version", () => {
    const parts = encryptToken(TOKEN).split(".");
    expect(() => decryptToken(["v2", parts[1], parts[2], parts[3]].join("."))).toThrow(
      /Unsupported encrypted token version/,
    );
  });

  it("does not disclose why decryption failed", () => {
    // A message distinguishing "wrong key" from "tampered" is an oracle.
    const parts = encryptToken(TOKEN).split(".");
    const tag = Buffer.from(parts[2]!, "base64url");
    tag[0] = (tag[0] ?? 0) ^ 0xff;

    try {
      decryptToken([parts[0], parts[1], tag.toString("base64url"), parts[3]].join("."));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toBe("Failed to decrypt token");
    }
  });
});

describe("token masking", () => {
  it("renders the specified format from a plaintext token", () => {
    expect(maskToken("EAABwzLixnjYBOabcdABCD")).toBe("••••••••••••ABCD");
  });

  it("renders the same format from the stored suffix alone", () => {
    // This is the path the UI actually uses: it never holds a plaintext token.
    expect(maskFromLastFour("ABCD")).toBe("••••••••••••ABCD");
  });

  it("shows bullets only when there is no token", () => {
    expect(maskFromLastFour(null)).toBe("••••••••••••");
    expect(maskFromLastFour(undefined)).toBe("••••••••••••");
    expect(maskFromLastFour("")).toBe("••••••••••••");
  });

  it("exposes at most four characters, whatever the input", () => {
    const masked = maskToken(TOKEN);
    const visible = masked.replaceAll("•", "");

    expect(visible).toHaveLength(4);
    expect(visible).toBe(TOKEN.slice(-4));
    expect(masked).not.toContain(TOKEN.slice(0, 8));
  });

  it("never reveals the beginning of a token", () => {
    // The prefix identifies the app and is the more sensitive half.
    expect(maskToken(TOKEN)).not.toContain("EAAB");
  });

  it("degrades safely for implausibly short input", () => {
    expect(maskToken("abc")).toBe("••••••••••••");
  });

  it("extracts exactly the last four characters", () => {
    expect(lastFourOf(TOKEN)).toBe("9f2Q");
    expect(lastFourOf("ab")).toBe("ab");
  });
});

describe("secureCompare", () => {
  it("matches identical strings", () => {
    expect(secureCompare("abc123", "abc123")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(secureCompare("abc123", "abc124")).toBe(false);
  });

  it("rejects strings of differing length without throwing", () => {
    expect(secureCompare("abc", "abcdef")).toBe(false);
    expect(secureCompare("", "x")).toBe(false);
  });
});

describe("a different key cannot read the ciphertext", () => {
  /**
   * Distinct from the tamper tests above, which corrupt the envelope. Here the
   * envelope is intact and the key is simply wrong — the case that matters when
   * a database dump is taken without `TOKEN_ENCRYPTION_KEY`, or when the key is
   * rotated and old rows have not been re-encrypted yet.
   *
   * The crypto module caches the parsed environment, so each key needs a fresh
   * module registry.
   */
  async function withKey(hexKey: string) {
    vi.resetModules();
    process.env.TOKEN_ENCRYPTION_KEY = hexKey;
    return import("@/lib/crypto/tokens");
  }

  const KEY_A = "a".repeat(64);
  const KEY_B = "b".repeat(64);
  const original = process.env.TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = original;
    vi.resetModules();
  });

  it("refuses ciphertext produced under another key", async () => {
    const a = await withKey(KEY_A);
    const envelope = a.encryptToken(TOKEN);

    const b = await withKey(KEY_B);

    // `b.TokenCryptoError`, not `a`'s: `resetModules` gives each import its own
    // module instance, so the two classes are distinct identities even though
    // they come from the same file.
    expect(() => b.decryptToken(envelope)).toThrow(b.TokenCryptoError);
  });

  it("says only that decryption failed, never that the key was wrong", async () => {
    /*
     * "Wrong key" and "corrupt data" must be indistinguishable to a caller.
     * Telling them apart is an oracle: it confirms to an attacker holding a
     * dump that a guessed key is closer than another.
     */
    const a = await withKey(KEY_A);
    const envelope = a.encryptToken(TOKEN);

    const b = await withKey(KEY_B);

    let message = "";
    try {
      b.decryptToken(envelope);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Failed to decrypt token");
    expect(message).not.toMatch(/key|tag|auth|unable/i);
  });

  it("still round-trips under the key that produced it", async () => {
    const a = await withKey(KEY_A);
    expect(a.decryptToken(a.encryptToken(TOKEN))).toBe(TOKEN);
  });
});

describe("TOKEN_ENCRYPTION_KEY is validated before it is used", () => {
  async function keyIsAccepted(value: string): Promise<boolean> {
    vi.resetModules();
    process.env.TOKEN_ENCRYPTION_KEY = value;

    const { encryptToken } = await import("@/lib/crypto/tokens");

    try {
      encryptToken("probe");
      return true;
    } catch {
      return false;
    }
  }

  const original = process.env.TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = original;
    vi.resetModules();
  });

  it("accepts 64 hex characters", async () => {
    expect(await keyIsAccepted("0".repeat(64))).toBe(true);
  });

  it("accepts 44-character base64", async () => {
    expect(await keyIsAccepted(Buffer.alloc(32, 7).toString("base64"))).toBe(true);
  });

  it("rejects a key that is too short to be 32 bytes", async () => {
    // The failure mode this prevents is silent: a short key that still parses
    // would encrypt happily and weaken every token in the database.
    for (const bad of ["0".repeat(32), "deadbeef", "", "not-a-key"]) {
      expect(await keyIsAccepted(bad), bad || "(empty)").toBe(false);
    }
  });
});
