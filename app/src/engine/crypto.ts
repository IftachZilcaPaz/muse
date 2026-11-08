/**
 * The encrypted secrets bundle: every .env-like file the project ignores on purpose, packed into one
 * JSON document and encrypted with age to two recipients (device key + recovery key).
 */
import { createHash } from "node:crypto";
import * as age from "age-encryption";

export type EnvFiles = Record<string, Buffer>;

export interface Bundle {
  ciphertext: Buffer;
  /** Digest of the plaintext, used to detect "nothing changed" without decrypting. */
  digest: string;
}

export function envDigest(files: EnvFiles): string {
  const h = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    h.update(name).update("\0").update(files[name]).update("\0");
  }
  return h.digest("hex");
}

export async function encryptBundle(files: EnvFiles, recipients: string[]): Promise<Bundle> {
  const doc = { v: 1, files: Object.fromEntries(Object.keys(files).sort().map((n) => [n, files[n].toString("base64")])) };
  const enc = new age.Encrypter();
  for (const r of recipients) enc.addRecipient(r);
  const ct = await enc.encrypt(new TextEncoder().encode(JSON.stringify(doc)));
  return { ciphertext: Buffer.from(ct), digest: envDigest(files) };
}

export async function decryptBundle(ciphertext: Buffer, identity: string): Promise<EnvFiles> {
  const dec = new age.Decrypter();
  dec.addIdentity(identity);
  const text = await dec.decrypt(new Uint8Array(ciphertext), "text");
  const doc = JSON.parse(text) as { v: number; files: Record<string, string> };
  const out: EnvFiles = {};
  for (const [name, b64] of Object.entries(doc.files)) {
    if (name.startsWith("/") || name.split("/").includes("..")) continue; // never write outside the project
    out[name] = Buffer.from(b64, "base64");
  }
  return out;
}
