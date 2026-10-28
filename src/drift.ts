/**
 * Compares the Drizzle schema with the live database: tables and columns that
 * exist on one side only, and columns whose type or nullability differ. It
 * reads the catalog directly, so it needs no drizzle-kit and never prompts.
 */

import type { Database } from './database.js';
import type { SchemaModel } from './model.js';
import type { Project } from './project.js';

export interface ColumnDrift {
	table: string;
	column: string;
	schema?: string;
	database?: string;
}

export interface Drift {
	inSync: boolean;
	/** Tables the code declares that the database doesn't have. */
	missingTables: string[];
	/** Tables in the database the code doesn't declare. */
	extraTables: string[];
	missingColumns: ColumnDrift[];
	extraColumns: ColumnDrift[];
	typeChanges: ColumnDrift[];
	nullabilityChanges: ColumnDrift[];
}

interface LiveColumn {
	table: string;
	column: string;
	type: string;
	notNull: boolean;
	primaryKey: boolean;
}

/** Postgres spells some types differently from Drizzle. */
export function normalizePgType(type: string): string {
	let t = type
		.toLowerCase()
		.replaceAll('"', '')
		.replace(/\s*,\s*/g, ',')
		.replace(/\s+/g, ' ')
		.trim();
	const array = /(\[\])+$/.exec(t)?.[0] ?? '';
	t = t.slice(0, t.length - array.length);
	t = t
		.replace(/^serial$/, 'integer')
		.replace(/^bigserial$/, 'bigint')
		.replace(/^smallserial$/, 'smallint')
		.replace(/^int4$|^int$/, 'integer')
		.replace(/^int8$/, 'bigint')
		.replace(/^int2$/, 'smallint')
		.replace(/^float8$/, 'double precision')
		.replace(/^float4$/, 'real')
		.replace(/^bool$/, 'boolean')
		.replace(/^varchar/, 'character varying')
		.replace(/^char(\(|$)/, 'character$1')
		.replace(/^timestamptz$/, 'timestamp with time zone')
		.replace(/^(timestamp|time)(\(\d+\))?$/, '$1$2 without time zone')
		.replace(/^public\./, '');
	if (t === 'character') t = 'character(1)';
	return t + array;
}

function normalizeSqliteType(type: string): string {
	return type.toLowerCase().replace(/\s+/g, '');
}

async function livePg(database: Database, schemas: string[], ignore: Set<string>): Promise<LiveColumn[]> {
	const list = schemas.map((schema) => `'${schema.replaceAll("'", "''")}'`).join(', ');
	const result = await database.read(
		`select n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
			coalesce(a.attnum = any(i.indkey), false)
		from pg_attribute a
		join pg_class c on c.oid = a.attrelid
		join pg_namespace n on n.oid = c.relnamespace
		left join pg_index i on i.indrelid = c.oid and i.indisprimary
		where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped and n.nspname in (${list})
		order by 1, 2, a.attnum`,
		[],
		100_000,
	);
	return result.rows
		.map(([schema, table, column, type, notNull, primaryKey]) => ({
			table: schema === 'public' ? String(table) : `${schema}.${table}`,
			column: String(column),
			type: String(type),
			notNull: Boolean(notNull),
			primaryKey: Boolean(primaryKey),
		}))
		.filter((column) => !ignore.has(column.table));
}

async function liveSqlite(database: Database, ignore: Set<string>): Promise<LiveColumn[]> {
	const tables = await database.read(
		"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' order by name",
		[],
		10_000,
	);
	const columns: LiveColumn[] = [];
	for (const [name] of tables.rows) {
		const table = String(name);
		if (ignore.has(table)) continue;
		const info = await database.read(
			`select name, type, "notnull", pk from pragma_table_info(${quoteSqliteString(table)})`,
			[],
			10_000,
		);
		for (const [column, type, notNull, pk] of info.rows) {
			columns.push({
				table,
				column: String(column),
				type: String(type),
				notNull: Boolean(notNull),
				primaryKey: Number(pk) > 0,
			});
		}
	}
	return columns;
}

function quoteSqliteString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export async function findDrift(project: Project, model: SchemaModel, database: Database): Promise<Drift> {
	const migrations = project.config.migrations ?? {};
	const ignore = new Set([
		migrations.table ?? '__drizzle_migrations',
		`${migrations.schema ?? 'drizzle'}.${migrations.table ?? '__drizzle_migrations'}`,
	]);
	const qualified = (table: { schema?: string; name: string }) =>
		table.schema && table.schema !== 'public' ? `${table.schema}.${table.name}` : table.name;

	let live: LiveColumn[];
	if (model.dialect === 'postgresql') {
		const filter = project.config.schemaFilter;
		const schemas = new Set(filter ? (Array.isArray(filter) ? filter : [filter]) : ['public']);
		for (const table of model.tables) schemas.add(table.schema ?? 'public');
		live = await livePg(database, [...schemas], ignore);
	} else {
		live = await liveSqlite(database, ignore);
	}

	const normalize = model.dialect === 'postgresql' ? normalizePgType : normalizeSqliteType;
	const liveTables = new Map<string, Map<string, LiveColumn>>();
	for (const column of live) {
		if (!liveTables.has(column.table)) liveTables.set(column.table, new Map());
		liveTables.get(column.table)?.set(column.column, column);
	}

	const drift: Drift = {
		inSync: true,
		missingTables: [],
		extraTables: [],
		missingColumns: [],
		extraColumns: [],
		typeChanges: [],
		nullabilityChanges: [],
	};
	const declared = new Set<string>();
	for (const table of model.tables) {
		const name = qualified(table);
		declared.add(name);
		const columns = liveTables.get(name);
		if (!columns) {
			drift.missingTables.push(name);
			continue;
		}
		for (const column of table.columns) {
			const actual = columns.get(column.name);
			if (!actual) {
				drift.missingColumns.push({ table: name, column: column.name, schema: column.type });
				continue;
			}
			if (normalize(column.type) !== normalize(actual.type)) {
				drift.typeChanges.push({ table: name, column: column.name, schema: column.type, database: actual.type });
			}
			// SQLite doesn't record NOT NULL on an INTEGER PRIMARY KEY, though it can't be null.
			const skipNullability = model.dialect === 'sqlite' && actual.primaryKey;
			if (!skipNullability && column.notNull !== actual.notNull) {
				drift.nullabilityChanges.push({
					table: name,
					column: column.name,
					schema: column.notNull ? 'not null' : 'nullable',
					database: actual.notNull ? 'not null' : 'nullable',
				});
			}
		}
		const known = new Set(table.columns.map((column) => column.name));
		for (const [name_, column] of columns) {
			if (!known.has(name_)) drift.extraColumns.push({ table: name, column: name_, database: column.type });
		}
	}
	for (const name of liveTables.keys()) if (!declared.has(name)) drift.extraTables.push(name);

	drift.inSync = [
		drift.missingTables,
		drift.extraTables,
		drift.missingColumns,
		drift.extraColumns,
		drift.typeChanges,
		drift.nullabilityChanges,
	].every((list) => list.length === 0);
	return drift;
}

export function describeDrift(drift: Drift): string {
	if (drift.inSync) return 'The database matches the Drizzle schema: same tables, columns, types and nullability.';
	const lines = ['The database differs from the Drizzle schema.', ''];
	const section = (title: string, items: string[]) => {
		if (items.length > 0) lines.push(`${title}:`, ...items.map((item) => `- ${item}`), '');
	};
	section('Tables in the schema but not the database', drift.missingTables);
	section('Tables in the database but not the schema', drift.extraTables);
	section(
		'Columns in the schema but not the database',
		drift.missingColumns.map((c) => `${c.table}.${c.column} (${c.schema})`),
	);
	section(
		'Columns in the database but not the schema',
		drift.extraColumns.map((c) => `${c.table}.${c.column} (${c.database})`),
	);
	section(
		'Columns whose type differs',
		drift.typeChanges.map((c) => `${c.table}.${c.column}: ${c.schema} in the schema, ${c.database} in the database`),
	);
	section(
		'Columns whose nullability differs',
		drift.nullabilityChanges.map(
			(c) => `${c.table}.${c.column}: ${c.schema} in the schema, ${c.database} in the database`,
		),
	);
	lines.push(
		"Usually this means migrations haven't been applied (see `migrations`), or the schema changed without one. `drizzle-kit generate` then `drizzle-kit migrate` brings the database in line; `drizzle-kit push` does it directly in development.",
	);
	return lines.join('\n');
}
