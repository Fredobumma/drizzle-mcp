/**
 * Which migrations in the project's `out` folder have been applied, using
 * the same rule as drizzle-orm's migrator, and which were edited afterwards.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Database } from './database.js';
import type { SqlDialect } from './model.js';
import { type Project, projectPath } from './project.js';
import { quoteIdentifier } from './sql.js';

export interface MigrationStatus {
	tag: string;
	/** When it was generated: the `when` drizzle-kit wrote in the journal. */
	createdAt: string;
	status: 'applied' | 'pending' | 'edited';
}

export interface Migrations {
	folder: string;
	table: string;
	migrations: MigrationStatus[];
	/** Rows in the migrations table with no matching file. */
	unknown: Array<{ hash: string; createdAt: string }>;
}

interface Journal {
	entries: Array<{ idx: number; when: number; tag: string }>;
}

export async function migrationStatus(project: Project, dialect: SqlDialect, database: Database): Promise<Migrations> {
	const folder = projectPath(project, project.config.out ?? 'drizzle');
	const journalPath = join(folder, 'meta', '_journal.json');
	if (!existsSync(journalPath)) {
		throw new Error(
			`There's no migration journal at ${journalPath}. Generate migrations with \`drizzle-kit generate\`, or check \`out\` in the config.`,
		);
	}
	const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;

	const name = project.config.migrations?.table ?? '__drizzle_migrations';
	const schema = project.config.migrations?.schema ?? 'drizzle';
	const table =
		dialect === 'postgresql' ? `${quoteIdentifier(schema)}.${quoteIdentifier(name)}` : quoteIdentifier(name);

	let applied: Array<{ hash: string; createdAt: number }> = [];
	try {
		const result = await database.read(`select hash, created_at from ${table} order by created_at`, [], 100_000);
		applied = result.rows.map(([hash, createdAt]) => ({ hash: String(hash), createdAt: Number(createdAt) }));
	} catch (error) {
		// No migrations table yet means nothing has been applied.
		if (!/does not exist|no such table/i.test(String((error as Error).message))) throw error;
	}

	// drizzle-orm applies every migration generated after the newest applied one.
	const last = applied.reduce((max, row) => Math.max(max, row.createdAt), Number.NEGATIVE_INFINITY);
	const byTime = new Map(applied.map((row) => [row.createdAt, row.hash]));
	const migrations: MigrationStatus[] = [];
	for (const entry of journal.entries) {
		const createdAt = new Date(entry.when).toISOString();
		if (entry.when > last) {
			migrations.push({ tag: entry.tag, createdAt, status: 'pending' });
			continue;
		}
		const sql = await readFile(join(folder, `${entry.tag}.sql`), 'utf8').catch(() => null);
		const hash = sql === null ? null : createHash('sha256').update(sql).digest('hex');
		const recorded = byTime.get(entry.when);
		migrations.push({
			tag: entry.tag,
			createdAt,
			status: recorded && hash && recorded !== hash ? 'edited' : 'applied',
		});
	}
	const known = new Set(journal.entries.map((entry) => entry.when));
	const unknown = applied
		.filter((row) => !known.has(row.createdAt))
		.map((row) => ({ hash: row.hash, createdAt: new Date(row.createdAt).toISOString() }));

	return {
		folder: relative(project.root, folder) || '.',
		table: dialect === 'postgresql' ? `${schema}.${name}` : name,
		migrations,
		unknown,
	};
}

export function describeMigrations(status: Migrations): string {
	const pending = status.migrations.filter((migration) => migration.status === 'pending');
	const edited = status.migrations.filter((migration) => migration.status === 'edited');
	const lines = [
		`${status.migrations.length} ${status.migrations.length === 1 ? 'migration' : 'migrations'} in ${status.folder}/: ${status.migrations.length - pending.length} applied, ${pending.length} pending.`,
		'',
		...status.migrations.map(
			(migration) => `- ${migration.tag} (${migration.createdAt.slice(0, 10)}): ${migration.status}`,
		),
	];
	if (edited.length > 0) {
		lines.push(
			'',
			`Edited after being applied: ${edited.map((migration) => migration.tag).join(', ')}. The database ran an earlier version of these files.`,
		);
	}
	if (status.unknown.length > 0) {
		lines.push('', `${status.unknown.length} applied migrations in ${status.table} have no file in ${status.folder}/.`);
	}
	if (pending.length > 0) lines.push('', 'Apply pending migrations with `drizzle-kit migrate`.');
	return lines.join('\n');
}
