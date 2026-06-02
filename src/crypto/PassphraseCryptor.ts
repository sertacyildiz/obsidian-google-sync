import { Cryptor } from "../sync/Cryptor";
import { aesGcmDecrypt, aesGcmEncrypt, deriveAesKey } from "./aesgcm";

/** OWASP-aligned PBKDF2-SHA256 work factor (derived once, then cached). */
export const PBKDF2_ITERATIONS = 600_000;

/** Random salt for key derivation. Not secret — store it in plugin config. */
export function newSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * The E2EE content cryptor for the sync pipeline. Holds a derived AES-GCM key;
 * encrypts before upload and decrypts after download. A credential or backend
 * leak therefore never exposes note content. A forgotten passphrase = no
 * recovery (the inherent cost of true E2EE).
 */
export class PassphraseCryptor implements Cryptor {
  private constructor(private readonly key: CryptoKey) {}

  static async fromPassphrase(
    passphrase: string,
    salt: Uint8Array,
    iterations: number = PBKDF2_ITERATIONS
  ): Promise<PassphraseCryptor> {
    return new PassphraseCryptor(await deriveAesKey(passphrase, salt, iterations));
  }

  static fromKey(key: CryptoKey): PassphraseCryptor {
    return new PassphraseCryptor(key);
  }

  encrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
    return aesGcmEncrypt(this.key, data);
  }

  decrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
    return aesGcmDecrypt(this.key, data);
  }
}
