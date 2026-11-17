/** Isolated, disposable native PostgreSQL. Never reads DATABASE_URL or contacts Supabase. */
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { createServer } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SUPABASE_STUB } from "../db/harness";

export async function startNativePostgres() {
  const directory = await mkdtemp(join(tmpdir(), "saju-pg-"));
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const password = randomUUID();
  const logs: string[] = [];
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, "data"),
    port,
    user: "postgres",
    password,
    persistent: false,
    createPostgresUser: false,
    autoRehydrateSymlinks: true,
    authMethod: "scram-sha-256",
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
    postgresFlags: [
      "-h",
      "127.0.0.1",
      "-k",
      directory,
      "-c",
      "wal_level=logical",
    ],
    onLog: (line) => {
      logs.push(String(line));
      if (logs.length > 30) logs.shift();
    },
    onError: (line) => {
      logs.push(String(line));
      if (logs.length > 30) logs.shift();
    },
  });
  const pool = new Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password,
    database: "postgres",
    max: 12,
    connectionTimeoutMillis: 5000,
  });
  const close = async () => {
    await pool.end();
    try {
      await postgres.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await postgres.initialise();
    await postgres.start();
    await pool.query(SUPABASE_STUB);
    const migrations = join(import.meta.dirname, "../../supabase/migrations");
    for (const file of (await readdir(migrations))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(join(migrations, file), "utf8"));
    return { pool, close };
  } catch (error) {
    await close().catch(() => {});
    throw new Error(`Isolated PostgreSQL startup failed: ${logs.join("\n")}`, {
      cause: error,
    });
  }
}
