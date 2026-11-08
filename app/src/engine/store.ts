/**
 * Engine state. Week 1 keeps it in a JSON file behind an interface, so SQLite (WAL, one writer, many
 * MCP readers) can replace it in week 4 without touching the engine. Keys live in the state dir for
 * now; the app moves the device key to the Keychain.
 */
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as age from "age-encryption";
import type { ProjectRecord } from "./types.js";

export const RECOVERY_KIT_NAME = "TIME-MACHINE-RECOVERY-KIT.txt";

interface StateFile {
  machineId: string;
  projects: Record<string, ProjectRecord>;
  /** slug -> tmId -> current sha. Stable ids survive thinning, shas do not. */
  index: Record<string, Record<string, string>>;
  /** slug -> accepted finding fingerprints ("I rotated / I understand"). */
  acks: Record<string, string[]>;
}

export interface Store {
  readonly machineId: string;
  listProjects(): ProjectRecord[];
  getProject(slug: string): ProjectRecord | undefined;
  putProject(p: ProjectRecord): Promise<void>;
  acks(slug: string): Set<string>;
  addAcks(slug: string, fingerprints: string[]): Promise<void>;
  index(slug: string): Record<string, string>;
  setIndex(slug: string, idx: Record<string, string>): Promise<void>;
  /** age recipients (device + recovery). */
  recipients(): Promise<string[]>;
  /** The device identity, used to decrypt on this machine. */
  deviceIdentity(): Promise<string>;
  recoveryKitPath(): string;
}

export class JsonStore implements Store {
  private data!: StateFile;
  private constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<JsonStore> {
    const s = new JsonStore(dir);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "state.json");
    s.data = existsSync(file)
      ? JSON.parse(await fs.readFile(file, "utf8"))
      : { machineId: randomBytes(4).toString("hex"), projects: {}, index: {}, acks: {} };
    await s.ensureKeys();
    await s.save();
    return s;
  }

  private async save() {
    await fs.writeFile(path.join(this.dir, "state.json"), JSON.stringify(this.data, null, 1));
  }

  private async ensureKeys() {
    const dev = path.join(this.dir, "device.key");
    const rec = path.join(this.dir, "recovery.key");
    if (!existsSync(dev)) await fs.writeFile(dev, (await age.generateIdentity()) + "\n", { mode: 0o600 });
    if (!existsSync(rec)) {
      const identity = await age.generateIdentity();
      await fs.writeFile(rec, identity + "\n", { mode: 0o600 });
      await fs.writeFile(
        path.join(this.dir, RECOVERY_KIT_NAME),
        [
          "TIME MACHINE RECOVERY KIT",
          "Keep this somewhere that survives your computer: password manager, iCloud Drive, or print it.",
          "Without it, the encrypted .env files in your backups cannot be read on a new machine.",
          "",
          identity,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
    }
  }

  get machineId() {
    return this.data.machineId;
  }
  listProjects() {
    return Object.values(this.data.projects);
  }
  getProject(slug: string) {
    return this.data.projects[slug];
  }
  async putProject(p: ProjectRecord) {
    this.data.projects[p.slug] = p;
    await this.save();
  }
  acks(slug: string) {
    return new Set(this.data.acks[slug] ?? []);
  }
  async addAcks(slug: string, fps: string[]) {
    const set = new Set([...(this.data.acks[slug] ?? []), ...fps]);
    this.data.acks[slug] = [...set];
    await this.save();
  }
  index(slug: string) {
    return this.data.index[slug] ?? {};
  }
  async setIndex(slug: string, idx: Record<string, string>) {
    this.data.index[slug] = idx;
    await this.save();
  }
  async recipients() {
    const ids = await Promise.all([this.deviceIdentity(), this.readKey("recovery.key")]);
    return Promise.all(ids.map((i) => age.identityToRecipient(i)));
  }
  deviceIdentity() {
    return this.readKey("device.key");
  }
  /** Test helper: the recovery identity, as a user would paste it from the kit. */
  recoveryIdentity() {
    return this.readKey("recovery.key");
  }
  recoveryKitPath() {
    return path.join(this.dir, RECOVERY_KIT_NAME);
  }
  private async readKey(name: string) {
    return (await fs.readFile(path.join(this.dir, name), "utf8")).trim();
  }
}
