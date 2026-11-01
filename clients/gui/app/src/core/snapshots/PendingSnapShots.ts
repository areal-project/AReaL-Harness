import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  readPendingSnapShot,
  type DesktopPendingSnapShot,
  type DesktopSnapShot,
} from "@areal/workbench/desktop-contract/snapshots";

export class PendingSnapShots {
  constructor(private readonly directory: string) {}

  private async write(path: string, bytes: string | Buffer): Promise<void> {
    const file = await open(path + ".tmp", "w", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(path + ".tmp", path);
  }

  async add(pending: DesktopPendingSnapShot, png: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.write(join(this.directory, pending.id + ".png"), png);
    await this.write(join(this.directory, pending.id + ".json"), JSON.stringify(pending));
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async list(): Promise<DesktopPendingSnapShot[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    const items = await Promise.all(
      names
        .filter((name) => /^[a-f0-9-]{1,64}\.json$/i.test(name))
        .map(async (name) =>
          readPendingSnapShot(JSON.parse(await readFile(join(this.directory, name), "utf8"))),
        ),
    );
    return items.sort((a, b) => a.source.capturedAt.localeCompare(b.source.capturedAt));
  }

  async read(id: string): Promise<DesktopSnapShot> {
    const pending = readPendingSnapShot(
      JSON.parse(await readFile(join(this.directory, id + ".json"), "utf8")),
    );
    const png = await readFile(join(this.directory, id + ".png"));
    if (png.length !== pending.sizeBytes) throw new Error("SnapShot image is incomplete");
    return { ...pending, dataUrl: "data:image/png;base64," + png.toString("base64") };
  }

  async acknowledge(id: string): Promise<void> {
    await unlink(join(this.directory, id + ".json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await unlink(join(this.directory, id + ".png")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
