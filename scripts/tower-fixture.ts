import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function towerFixture(prefix: string, selected = process.env.ALLGATHER_TEST_TOWER) {
  if (!selected)
    throw new Error(
      "Set ALLGATHER_TEST_TOWER to tower-cli with sibling tower and tower-terminal-pool executables",
    );
  const cli = resolve(selected);
  if (basename(cli) !== "tower-cli")
    throw new Error(
      "ALLGATHER_TEST_TOWER must select tower-cli, not the Tower server or an old single-binary layout",
    );
  const sources = {
    cli,
    server: join(dirname(cli), "tower"),
    pool: join(dirname(cli), "tower-terminal-pool"),
  };
  for (const path of Object.values(sources)) {
    try {
      if (!statSync(path).isFile()) throw new Error("Not a file");
      accessSync(path, constants.R_OK | constants.X_OK);
    } catch {
      throw new Error(`Missing or non-executable Tower bundle member: ${path}`);
    }
  }
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    for (const source of Object.values(sources)) {
      const target = join(root, basename(source));
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      chmodSync(target, 0o700);
    }
    return {
      root,
      cli: join(root, "tower-cli"),
      server: join(root, "tower"),
      pool: join(root, "tower-terminal-pool"),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function stopFixturePool(
  bundle: ReturnType<typeof towerFixture>,
  env: NodeJS.ProcessEnv,
) {
  const child = Bun.spawn([bundle.pool, "stop"], {
    env,
    cwd: bundle.root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}
