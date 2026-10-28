/**
 * Reads tables, enums and relations out of a project's Drizzle schema, with
 * both the TypeScript names the code uses and the SQL names the database
 * uses. This is what plain database tools can't see.
 */

import type { Project } from './project.js';

export type SqlDialect = 'postgresql' | 'sqlite';

export interface ColumnModel {
	/** The property name in TypeScript, such as `createdAt`. */
	key: string;
	/** The column name in SQL, such as `created_at`. */
	name: string;
	/** The SQL type, such as `varchar(255)`. */
	type: string;
	/** How Drizzle maps values: `string`, `number`, `date`, `json`, `bigint`, `boolean`… */
	dataType: string;
	notNull: boolean;
	primaryKey: boolean;
	unique: boolean;
	/** The SQL default, or a note that the application sets it. */
	default?: string;
	enumValues?: string[];
}

export interface RelationModel {
	name: string;
	kind: 'one' | 'many';
	/** The related table's TypeScript export. */
	table: string;
	/** Columns on this table (TypeScript keys) that point at `references`. */
	fields: string[];
	/** Columns on the related table (TypeScript keys). */
	references: string[];
}

export interface TableModel {
	/** The TypeScript export, used by `db.query.<key>`. */
	key: string;
	/** The SQL table name. */
	name: string;
	/** The Postgres schema, when it isn't `public`. */
	schema?: string;
	/** The schema file that exports the table. */
	source?: string;
	columns: ColumnModel[];
	primaryKey: string[];
	indexes: Array<{ name: string; columns: string[]; unique: boolean; where?: string }>;
	foreignKeys: Array<{
		name: string;
		columns: string[];
		table: string;
		foreignColumns: string[];
		onDelete?: string;
		onUpdate?: string;
	}>;
	uniques: Array<{ name: string; columns: string[] }>;
	checks: Array<{ name: string; expression: string }>;
	relations: RelationModel[];
}

export interface EnumModel {
	key: string;
	name: string;
	schema?: string;
	values: string[];
}

export interface SchemaModel {
	dialect: SqlDialect;
	tables: TableModel[];
	enums: EnumModel[];
}

// The slices of drizzle-orm's runtime this module uses. They're read from the
// project's own copy, so they're described structurally rather than imported.
interface Column {
	name: string;
	dataType: string;
	keyAsName?: boolean;
	notNull: boolean;
	hasDefault: boolean;
	default?: unknown;
	defaultFn?: unknown;
	onUpdateFn?: unknown;
	primary: boolean;
	isUnique: boolean;
	enumValues?: string[];
	getSQLType(): string;
}

interface TableConfig {
	name: string;
	schema?: string;
	columns: Column[];
	indexes: Array<{ config: { name?: string; columns: unknown[]; unique?: boolean; where?: unknown } }>;
	foreignKeys: Array<{
		getName(): string;
		onDelete?: string;
		onUpdate?: string;
		reference(): { columns: Column[]; foreignTable: unknown; foreignColumns: Column[] };
	}>;
	primaryKeys: Array<{ columns: Column[] }>;
	uniqueConstraints: Array<{ getName(): string; columns: Column[] }>;
	checks: Array<{ name: string; value: unknown }>;
}

interface Relation {
	referencedTable: unknown;
	referencedTableName: string;
}

export interface Orm {
	is(value: unknown, type: unknown): boolean;
	Table: unknown;
	SQL: unknown;
	One: unknown;
	getTableName(table: unknown): string;
	getTableColumns(table: unknown): Record<string, Column>;
	createTableRelationsHelpers: unknown;
	extractTablesRelationalConfig(
		schema: Record<string, unknown>,
		helpers: unknown,
	): {
		tables: Record<string, { tsName: string; dbName: string; relations: Record<string, Relation> }>;
		tableNamesMap: Record<string, string>;
	};
	normalizeRelation(
		tables: unknown,
		tableNamesMap: Record<string, string>,
		relation: Relation,
	): { fields: Column[]; references: Column[] };
}

interface Core {
	getTableConfig(table: unknown): TableConfig;
	isPgEnum?: (value: unknown) => boolean;
	PgDialect?: new (config?: object) => Dialect;
	SQLiteSyncDialect?: new (config?: object) => Dialect;
}

interface Dialect {
	sqlToQuery(sql: unknown): { sql: string; params: unknown[] };
}

/** `postgresql` or `sqlite`, the dialects the server supports. */
export function sqlDialect(project: Project): SqlDialect {
	const { dialect } = project.config;
	if (dialect === 'postgresql') return 'postgresql';
	if (dialect === 'sqlite' || dialect === 'turso') return 'sqlite';
	throw new Error(`The ${dialect} dialect isn't supported yet: drizzle-mcp works with PostgreSQL and SQLite.`);
}

function words(input: string): string[] {
	return input.replace(/['’]/g, '').match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [];
}

/** The SQL name of a column declared without one, under the config's `casing`. Matches drizzle-orm. */
function cased(key: string, casing: Project['config']['casing']): string {
	if (casing === 'snake_case') {
		return words(key)
			.map((word) => word.toLowerCase())
			.join('_');
	}
	if (casing === 'camelCase') {
		return words(key)
			.map((word, i) => (i === 0 ? word.toLowerCase() : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
			.join('');
	}
	return key;
}

export async function readSchema(project: Project): Promise<SchemaModel> {
	const dialect = sqlDialect(project);
	const orm = await project.import<Orm>('drizzle-orm');
	const core = await project.import<Core>(dialect === 'postgresql' ? 'drizzle-orm/pg-core' : 'drizzle-orm/sqlite-core');
	const SqlDialectClass = dialect === 'postgresql' ? core.PgDialect : core.SQLiteSyncDialect;
	if (!SqlDialectClass) throw new Error("The project's drizzle-orm is missing its dialect classes. Is it up to date?");
	const renderer = new SqlDialectClass({ casing: project.config.casing });
	const render = (value: unknown) => renderer.sqlToQuery(value).sql;
	const casing = project.config.casing;
	const sqlName = (column: Column, key?: string) => (column.keyAsName && key ? cased(key, casing) : column.name);

	const tables: TableModel[] = [];
	const enums: EnumModel[] = [];
	const keyOfTable = new Map<unknown, string>();

	for (const [key, value] of Object.entries(project.exports)) {
		if (core.isPgEnum?.(value)) {
			const pgEnum = value as { enumName: string; enumValues: string[]; schema?: string };
			enums.push({ key, name: pgEnum.enumName, values: [...pgEnum.enumValues], schema: pgEnum.schema });
		}
		if (orm.is(value, orm.Table)) keyOfTable.set(value, key);
	}

	for (const [table, key] of keyOfTable) {
		const config = core.getTableConfig(table);
		const keys = new Map<Column, string>();
		for (const [property, column] of Object.entries(orm.getTableColumns(table))) keys.set(column, property);
		const nameOf = (column: Column) => sqlName(column, keys.get(column));
		const indexColumn = (column: unknown) =>
			orm.is(column, orm.SQL) ? render(column) : nameOf(column as Column) || (column as { name: string }).name;

		const columns = config.columns.map((column): ColumnModel => {
			let fallback: string | undefined;
			if (column.default !== undefined) {
				fallback = orm.is(column.default, orm.SQL) ? render(column.default) : JSON.stringify(column.default);
			} else if (column.defaultFn) {
				fallback = 'set by the application ($defaultFn)';
			} else if (column.onUpdateFn) {
				fallback = 'set by the application ($onUpdate)';
			}
			const type = column.getSQLType();
			return {
				key: keys.get(column) ?? column.name,
				name: nameOf(column),
				type,
				dataType: column.dataType,
				notNull: column.notNull,
				primaryKey: column.primary,
				unique: column.isUnique,
				...(fallback !== undefined ? { default: fallback } : {}),
				...(column.enumValues?.length ? { enumValues: [...column.enumValues] } : {}),
			};
		});

		const composite = config.primaryKeys[0]?.columns.map(nameOf);
		tables.push({
			key,
			name: config.name,
			...(config.schema ? { schema: config.schema } : {}),
			...(project.sources.has(key) ? { source: project.sources.get(key) } : {}),
			columns,
			primaryKey: composite ?? columns.filter((column) => column.primaryKey).map((column) => column.name),
			indexes: config.indexes.map((index) => ({
				name: index.config.name ?? '',
				columns: index.config.columns.map(indexColumn),
				unique: index.config.unique ?? false,
				...(index.config.where ? { where: render(index.config.where) } : {}),
			})),
			foreignKeys: config.foreignKeys.map((foreignKey) => {
				const reference = foreignKey.reference();
				return {
					name: foreignKey.getName(),
					columns: reference.columns.map(nameOf),
					table: orm.getTableName(reference.foreignTable),
					foreignColumns: reference.foreignColumns.map((column) => column.name),
					...(foreignKey.onDelete ? { onDelete: foreignKey.onDelete } : {}),
					...(foreignKey.onUpdate ? { onUpdate: foreignKey.onUpdate } : {}),
				};
			}),
			uniques: config.uniqueConstraints.map((unique) => ({
				name: unique.getName(),
				columns: unique.columns.map(nameOf),
			})),
			checks: config.checks.map((check) => ({ name: check.name, expression: render(check.value) })),
			relations: [],
		});
	}

	// Relations come from `relations()` exports, normalised the way relational queries see them.
	if (tables.length > 0) {
		const { tables: relational, tableNamesMap } = orm.extractTablesRelationalConfig(
			project.exports,
			orm.createTableRelationsHelpers,
		);
		const byKey = new Map(tables.map((table) => [table.key, table]));
		for (const [key, config] of Object.entries(relational)) {
			const table = byKey.get(key);
			if (!table) continue;
			for (const [name, relation] of Object.entries(config.relations)) {
				const normalized = orm.normalizeRelation(relational, tableNamesMap, relation);
				const target =
					keyOfTable.get(relation.referencedTable) ??
					tableNamesMap[relation.referencedTableName] ??
					relation.referencedTableName;
				const targetColumns = new Map(byKey.get(target)?.columns.map((column) => [column.name, column.key]));
				const ownColumns = new Map(table.columns.map((column) => [column.name, column.key]));
				// For both kinds, `fields` are on this table and `references` on the related one.
				table.relations.push({
					name,
					kind: orm.is(relation, orm.One) ? 'one' : 'many',
					table: target,
					fields: normalized.fields.map((column) => ownColumns.get(column.name) ?? column.name),
					references: normalized.references.map((column) => targetColumns.get(column.name) ?? column.name),
				});
			}
		}
	}

	tables.sort((a, b) => a.key.localeCompare(b.key));
	return { dialect, tables, enums };
}

/** Finds a table by its TypeScript export or SQL name, optionally schema-qualified. */
export function findTable(model: SchemaModel, name: string): TableModel {
	const wanted = name.trim();
	const match =
		model.tables.find((table) => table.key === wanted) ??
		model.tables.find((table) => table.name === wanted) ??
		model.tables.find((table) => `${table.schema ?? 'public'}.${table.name}` === wanted);
	if (match) return match;
	const known = model.tables.map((table) => table.key).join(', ');
	throw new Error(`There's no table called "${name}". The schema has: ${known || 'no tables'}.`);
}

/** Finds a column by its TypeScript key or SQL name. */
export function findColumn(table: TableModel, name: string): ColumnModel {
	const match =
		table.columns.find((column) => column.key === name) ?? table.columns.find((column) => column.name === name);
	if (match) return match;
	const known = table.columns.map((column) => column.key).join(', ');
	throw new Error(`${table.key} has no column "${name}". Its columns are: ${known}.`);
}
