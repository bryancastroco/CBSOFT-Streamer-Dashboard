import { describe, expect, it } from "vitest";

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
