import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMigrationNames, checkMigrationDirectory, runMigrationCheck } from '../check-migrations.ts';

const files = (...names: string[]) => names.map(name => ({ name, isFile: true }));

test('distinct migration versions pass without requiring contiguous numbers', () => {
  assert.deepEqual(validateMigrationNames(files('20261125000100_inbox.sql', '20261125000500_updated_at.sql')),
    { ok: true, migrationCount: 2, issues: [] });
});

test('different filenames sharing the A/C or B/C version fail with both filenames', () => {
  for (const [version, left, right] of [
    ['20261125000100', 'fortune_provider_quota', 'groble_event_inbox'],
    ['20261125000200', 'match_preferences', 'groble_events_updated_at'],
  ]) {
    const result = validateMigrationNames(files(`${version}_${left}.sql`, `${version}_${right}.sql`));
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues, [{ code: 'DUPLICATE_VERSION', version,
      files: [`${version}_${left}.sql`, `${version}_${right}.sql`].sort() }]);
  }
});

test('malformed timestamps, missing descriptions and uppercase SQL extensions fail explicitly', () => {
  const bad = ['002_quota.sql', '20261125000300.sql', '20261125000300_.sql', '20261125000300_quota.SQL'];
  const result = validateMigrationNames(files(...bad));
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, bad.length);
  assert.ok(result.issues.every(issue => issue.code === 'INVALID_FILENAME'));
});

test('documentation and temporary files do not count as migrations', () => {
  const result = validateMigrationNames(files('README.md', '20261125000300_quota.sql.bak', '20261125000400_lock.sql'));
  assert.deepEqual(result, { ok: true, migrationCount: 1, issues: [] });
  assert.deepEqual(validateMigrationNames(files('README.md')).issues, [{ code: 'NO_MIGRATIONS', files: [] }]);
});

test('real directory validation rejects SQL directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saju-migrations-'));
  try {
    await writeFile(join(directory, '20261125000100_inbox.sql'), 'select 1;');
    await mkdir(join(directory, '20261125000200_preferences.sql'));
    const result = await checkMigrationDirectory(directory);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues, [{ code: 'NOT_A_FILE', files: ['20261125000200_preferences.sql'] }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real directory validation rejects SQL symlinks without following them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'saju-migration-symlink-'));
  try {
    await writeFile(join(directory, '20261125000100_inbox.sql'), 'select 1;');
    try {
      await symlink(join(directory, '20261125000100_inbox.sql'), join(directory, '20261125000300_quota.sql'));
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows account does not have permission to create symbolic links');
        return;
      }
      throw error;
    }
    const result = await checkMigrationDirectory(directory);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues, [{ code: 'NOT_A_FILE', files: ['20261125000300_quota.sql'] }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a migration collision returns failure and cannot be hidden by successful raw SQL execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saju-migration-collision-'));
  try {
    await writeFile(join(directory, '20261125000200_preferences.sql'), 'select 1;');
    const reports: unknown[] = [];
    assert.equal(await runMigrationCheck(directory, report => reports.push(report)), 0);
    await writeFile(join(directory, '20261125000200_timestamps.sql'), 'select 2;');
    assert.equal(await runMigrationCheck(directory, report => reports.push(report)), 1);
    assert.match(JSON.stringify(reports.at(-1)), /DUPLICATE_VERSION/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unreadable paths fail without exposing the path or filesystem error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saju-migration-missing-'));
  await rm(directory, { recursive: true, force: true });
  const reports: unknown[] = [];
  assert.equal(await runMigrationCheck(directory, report => reports.push(report)), 1);
  assert.deepEqual(reports, [{ scope: 'local_migration_filenames', ok: false, code: 'MIGRATIONS_UNREADABLE' }]);
  assert.ok(!JSON.stringify(reports).includes(directory));
});
