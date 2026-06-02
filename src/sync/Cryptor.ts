/**
 * The encryption hook in the sync pipeline. Content is `encrypt`-ed before
 * upload and `decrypt`-ed after download. v1 default is the identity (no-op);
 * E2EE swaps in a passphrase-derived AEAD implementation (see THREAT-MODEL.md).
 */
export interface Cryptor {
  encrypt(data: ArrayBuffer): Promise<ArrayBuffer>;
  decrypt(data: ArrayBuffer): Promise<ArrayBuffer>;
}

export const identityCryptor: Cryptor = {
  async encrypt(data) {
    return data;
  },
  async decrypt(data) {
    return data;
  },
};
