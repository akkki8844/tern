import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { ConfigurationError, SecurityError } from "./errors.js";
import type { Secret } from "./secret.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

/**
 * Authenticated encryption for values Tern must store but must be able to read back
 * (currently: nothing in Turn 1 — provider tokens are re-minted rather than stored).
 * Kept as a first-class primitive so future persistence never invents its own scheme.
 */
export class EncryptionService {
  private readonly key: Buffer;

  constructor(keyMaterial: Secret | string) {
    const raw = typeof keyMaterial === "string" ? keyMaterial : keyMaterial.reveal();
    if (!raw || raw.length < 32) {
      throw new ConfigurationError("ENCRYPTION_KEY must be at least 32 characters", {
        code: "CONFIG_ENCRYPTION_KEY_INVALID"
      });
    }
    // Derive a fixed-length key; never use the raw passphrase directly.
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.alloc(0), Buffer.from("tern-encryption-v1"), 32));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(encoded: string): string {
    const parts = encoded.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new SecurityError("Ciphertext is malformed or uses an unsupported version", {
        code: "DECRYPT_FORMAT_INVALID"
      });
    }
    const [, ivPart, tagPart, dataPart] = parts;
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivPart, "base64url"));
      decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      // Never surface the underlying crypto error: it can leak oracle information.
      throw new SecurityError("Ciphertext failed authentication", { code: "DECRYPT_AUTH_FAILED" });
    }
  }
}
