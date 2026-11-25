/** Local filenames only: never connects to a database or reads environment files/SQL bodies. */
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationIssue {
  code: 'INVALID_FILENAME' | 'DUPLICATE_VERSION' | 'NOT_A_FILE' | 'NO_MIGRATIONS';
  files: string[];
  version?: string;
}

export function validateMigrationNames(entries: readonly { name: string; isFile: boolean }[]) {
  const issues: MigrationIssue[] = [];
  const versions = new Map<string, string[]>();
  const sqlEntries = entries.filter(entry => /\.sql$/i.test(entry.name));
  if (!sqlEntries.length) issues.push({ code: 'NO_MIGRATIONS', files: [] });
  for (const entry of [...sqlEntries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile) { issues.push({ code: 'NOT_A_FILE', files: [entry.name] }); continue; }
    const match = /^(\d{14})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/.exec(entry.name);
    if (!match) { issues.push({ code: 'INVALID_FILENAME', files: [entry.name] }); continue; }
    const version = match[1]!;
    const files = versions.get(version) ?? [];
    files.push(entry.name);
    versions.set(version, files);
  }
  for (const [version, files] of versions)
    if (files.length > 1) issues.push({ code: 'DUPLICATE_VERSION', version, files });
  return { ok: issues.length === 0, migrationCount: sqlEntries.length, issues };
}

export async function checkMigrationDirectory(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  return validateMigrationNames(entries.map(entry => ({ name: entry.name, isFile: entry.isFile() })));
}

export async function runMigrationCheck(directory: string, report: (value: unknown) => void): Promise<number> {
  try {
    const result = await checkMigrationDirectory(directory);
    report({ scope: 'local_migration_filenames', ...result });
    return result.ok ? 0 : 1;
  } catch {
    // Filesystem errors may contain local paths; report a stable code instead.
    report({ scope: 'local_migration_filenames', ok: false, code: 'MIGRATIONS_UNREADABLE' });
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runMigrationCheck(fileURLToPath(new URL('../supabase/migrations', import.meta.url)),
    value => console.log(JSON.stringify(value)));
}
