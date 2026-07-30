
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { getConfig } from "./config.js";
import { getLogger } from "./logger.js";
const logger = getLogger("encryption");

export class EncryptionService {
  private key?: Buffer;
  private enabled = false;
  constructor() {
    const key = getConfig().ENCRYPTION_KEY;
    if (key) {
      this.key = createHash("sha256").update(key).digest();
      this.enabled = true;
    } else {
      logger.warn("ENCRYPTION_KEY not set; encryption disabled");
    }
  }
  isEnabled(): boolean { return this.enabled; }
  encrypt(plain: string): string {
    if (!this.enabled || !this.key) return plain;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
  }
  decrypt(encrypted: string): string {
    if (!this.enabled || !this.key) return encrypted;
    const [ivHex, tagHex, dataHex] = encrypted.split(":");
    if (!ivHex || !tagHex || !dataHex) throw new Error("Invalid encrypted format");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const data = Buffer.from(dataHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }
}
