/**
 * The MCP server: tools that let an agent see the database the way Drizzle
 * Studio shows it to a person, through the project's own schema.
 */

import { stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connect, type Database, type DriverName, type DrizzleDb } from './database.js';
import { describeDrift, findDrift } from './drift.js';
import { type Filter, filterSchema, type Operators, toCondition } from './filters.js';
import {
	DEFAULT_REDACT,
	describeSchema,
	describeTable,
	type FormatOptions,
	isSecret,
	markdownTable,
	plain,
	redactRows,
} from './format.js';
import { describeMigrations, migrationStatus } from './migrations.js';
import { findColumn, findTable, readSchema, type SchemaModel, type TableModel } from './model.js';
import { type LoadOptions, loadProject, type Project } from './project.js';

export const VERSION = '0.1.1';

export interface ServerOptions extends LoadOptions {
	/** A connection string or file that overrides the config's `dbCredentials`. */
	url?: string;
	driver?: DriverName;
	/** Adds the `execute` tool and opens the database for writing. */
	allowWrites?: boolean;
	/** The most rows a tool returns. Defaults to 100. */
	maxRows?: number;
	/** Statement time limit in milliseconds. Defaults to 15 seconds. */
	timeout?: number;
	/** Columns whose names match are hidden. `null` shows everything. */
	redact?: RegExp | null;
	/** Strings longer than this are cut short. Defaults to 500 characters. */
	maxText?: number;
}

const INSTRUCTIONS = `This server shows the project's database through its Drizzle schema, like Drizzle Studio.

Start with \`schema\` to see the tables, then \`schema\` with a table for its columns and relations. Tables and columns can be named by their TypeScript key (createdAt) or SQL name (created_at); results use TypeScript keys, as \`db.query\` does.

Use \`browse\` to read rows with filters, sorting and related rows, \`count\` for totals and breakdowns, and \`query\` for any SELECT. \`drift\` compares the schema with the database and \`migrations\` lists pending migrations.

Everything runs in read-only transactions unless the server was started with --allow-writes. Values in columns that look like secrets are hidden, and results are capped.`;

/** Everything that depends on the project's files, reloaded when they change. */
class Session {
	private loaded?: Promise<{ project: Project; model: SchemaModel; stamps: number[] }>;
	private database?: Promise<Database>;

	constructor(private readonly options: ServerOptions) {}

	private async stamps(files: string[]): Promise<number[]> {
		return Promise.all(
			files.map((file) =>
				stat(file).then(
					(info) => info.mtimeMs,
					() => 0,
				),
			),
		);
	}

	/** The project and its schema, reloaded if a schema file changed since they were read. */
	async current(): Promise<{ project: Project; model: SchemaModel }> {
		if (this.loaded) {
			const loaded = await this.loaded.catch(() => null);
			if (loaded) {
				const now = await this.stamps(loaded.project.files);
				if (now.every((stamp, i) => stamp === loaded.stamps[i])) return loaded;
			}
			await this.closeDatabase();
		}
		this.loaded = (async () => {
			const project = await loadProject(this.options);
			const model = await readSchema(project);
			return { project, model, stamps: await this.stamps(project.files) };
		})();
		return this.loaded;
	}

	async db(): Promise<{ project: Project; model: SchemaModel; database: Database }> {
		const { project, model } = await this.current();
		this.database ??= connect(project, model.dialect, {
			url: this.options.url,
			driver: this.options.driver,
			allowWrites: this.options.allowWrites,
			timeout: this.options.timeout,
		});
		this.database.catch(() => {
			this.database = undefined;
		});
		return { project, model, database: await this.database };
	}

	async closeDatabase(): Promise<void> {
		const database = this.database;
		this.database = undefined;
		await (await database?.catch(() => undefined))?.close();
	}
}

/** A readable message from a database error, with Postgres's detail and hint. */
function messageOf(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const extra = error as Error & { detail?: string; hint?: string; cause?: unknown };
	const parts = [error.message];
	if (extra.detail) parts.push(`Detail: ${extra.detail}`);
	if (extra.hint) parts.push(`Hint: ${extra.hint}`);
	if (extra.cause instanceof Error && extra.cause.message !== error.message)
		parts.push(`Cause: ${messageOf(extra.cause)}`);
	return parts.join('\n');
}

type ToolResult = {
	content: Array<{ type: 'text'; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

async function run(work: () => Promise<{ text: string; data?: Record<string, unknown> }>): Promise<ToolResult> {
	try {
		const { text, data } = await work();
		return { content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}) };
	} catch (error) {
		return { content: [{ type: 'text', text: messageOf(error) }], isError: true };
	}
}

interface WithConfig {
	[relation: string]: true | { columns?: string[]; limit?: number; with?: WithConfig };
}

const withSchema: z.ZodType<WithConfig> = z.lazy(() =>
	z.record(
		z.string(),
		z.union([
			z.literal(true),
			z
				.object({
					columns: z.array(z.string()).optional(),
					limit: z.number().int().min(1).max(100).optional(),
					with: withSchema.optional(),
				})
				.strict(),
		]),
	),
) as z.ZodType<WithConfig>;

/** Translates `with` into Drizzle's relational query config, checking every relation and column. */
function toWith(
	config: WithConfig | undefined,
	table: TableModel,
	model: SchemaModel,
	orm: Orm,
	project: Project,
): Record<string, unknown> | undefined {
	if (!config) return undefined;
	const out: Record<string, unknown> = {};
	for (const [name, options] of Object.entries(config)) {
		const relation = table.relations.find((candidate) => candidate.name === name);
		if (!relation) {
			const known = table.relations.map((candidate) => candidate.name).join(', ') || 'none';
			throw new Error(`${table.key} has no relation "${name}". Its relations are: ${known}.`);
		}
		const target = findTable(model, relation.table);
		const settings = options === true ? {} : options;
		out[name] = {
			...(settings.columns
				? { columns: Object.fromEntries(settings.columns.map((column) => [findColumn(target, column).key, true])) }
				: {}),
			// Many-relations are capped so one row can't pull in thousands, in a stable order.
			...(relation.kind === 'many'
				? {
						limit: settings.limit ?? 10,
						orderBy: target.primaryKey.map((name) =>
							orm.asc(orm.getTableColumns(project.exports[target.key])[findColumn(target, name).key]),
						),
					}
				: {}),
			...(settings.with ? { with: toWith(settings.with, target, model, orm, project) } : {}),
		};
	}
	return out;
}

interface Orm extends Operators {
	getTableColumns(table: unknown): Record<string, unknown>;
	asc(column: unknown): unknown;
	desc(column: unknown): unknown;
	count(): unknown;
}

export async function createServer(
	options: ServerOptions = {},
): Promise<{ server: McpServer; close(): Promise<void> }> {
	const session = new Session(options);
	// Fail at start-up, not on the first call, if the project can't be read.
	await session.current();

	const maxRows = options.maxRows ?? 100;
	const format: FormatOptions = {
		redact: options.redact === undefined ? DEFAULT_REDACT : options.redact,
		maxText: options.maxText ?? 500,
	};
	const server = new McpServer({ name: 'drizzle-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
	const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

	server.registerTool(
		'schema',
		{
			title: 'Drizzle schema',
			description:
				'Lists the tables in the Drizzle schema with their TypeScript and SQL names, or with `table`, describes one: columns with types, nullability and defaults, keys, indexes, checks and relations.',
			inputSchema: { table: z.string().optional().describe('A table to describe: its TypeScript export or SQL name.') },
			annotations: { title: 'Drizzle schema', ...readOnly },
		},
		({ table }) =>
			run(async () => {
				const { model } = await session.current();
				if (!table)
					return {
						text: describeSchema(model),
						data: { dialect: model.dialect, tables: model.tables, enums: model.enums },
					};
				const found = findTable(model, table);
				return { text: describeTable(found), data: { table: found } };
			}),
	);

	server.registerTool(
		'browse',
		{
			title: 'Browse rows',
			description:
				"Reads rows from a table, like Drizzle Studio: pick columns, filter, sort, page, and include related rows through the schema's relations. Returns rows keyed by TypeScript property, plus the total matching.",
			inputSchema: {
				table: z.string().describe('The table: its TypeScript export or SQL name.'),
				columns: z.array(z.string()).optional().describe('Only these columns.'),
				where: filterSchema.optional(),
				orderBy: z
					.array(z.object({ column: z.string(), direction: z.enum(['asc', 'desc']).default('asc') }))
					.optional()
					.describe('Sort order. Defaults to the primary key.'),
				limit: z.number().int().min(1).max(maxRows).default(Math.min(20, maxRows)),
				offset: z.number().int().min(0).default(0),
				with: withSchema
					.optional()
					.describe(
						'Related rows to include, by relation name: {"author": true} or {"comments": {"limit": 5, "columns": ["body"], "with": {"author": true}}}. Many-relations return 10 rows unless you set a limit.',
					),
			},
			annotations: { title: 'Browse rows', ...readOnly },
		},
		(input) =>
			run(async () => {
				const { project, model, database } = await session.db();
				const table = findTable(model, input.table);
				const orm = await project.import<Orm>('drizzle-orm');
				const drizzleTable = project.exports[table.key];
				const columns = orm.getTableColumns(drizzleTable);
				const where = toCondition(input.where as Filter | undefined, table, columns, orm, model.dialect);
				const order = input.orderBy?.length
					? input.orderBy.map((entry) =>
							(entry.direction === 'desc' ? orm.desc : orm.asc)(columns[findColumn(table, entry.column).key]),
						)
					: table.primaryKey.map((name) => orm.asc(columns[findColumn(table, name).key]));
				const config = {
					...(input.columns
						? { columns: Object.fromEntries(input.columns.map((name) => [findColumn(table, name).key, true])) }
						: {}),
					...(where ? { where } : {}),
					orderBy: order,
					limit: input.limit,
					offset: input.offset,
					...(input.with ? { with: toWith(input.with, table, model, orm, project) } : {}),
				};
				const [rows, total] = await database.readOnly(async (db: DrizzleDb) => {
					const query = db.query[table.key];
					if (!query) throw new Error(`${table.key} isn't available to relational queries.`);
					const found = await query.findMany(config);
					const counted = (await (where
						? db.select({ value: orm.count() }).from(drizzleTable).where(where)
						: db.select({ value: orm.count() }).from(drizzleTable))) as Array<{ value: number }>;
					return [found, Number(counted[0]?.value ?? 0)] as const;
				});
				const safe = plain(redactRows(rows, format), format) as unknown[];
				const more = input.offset + safe.length < total ? ` Pass offset ${input.offset + safe.length} for more.` : '';
				const summary = `${table.key}: rows ${safe.length ? `${input.offset + 1}–${input.offset + safe.length}` : 'none'} of ${total}.${more}`;
				return {
					text: `${summary}\n\n${JSON.stringify(safe, null, 1)}`,
					data: { table: table.key, total, offset: input.offset, rows: safe },
				};
			}),
	);

	server.registerTool(
		'count',
		{
			title: 'Count rows',
			description:
				'Counts the rows in a table that match a filter. With `groupBy`, counts per distinct value, largest groups first: a quick way to see how data is distributed.',
			inputSchema: {
				table: z.string().describe('The table: its TypeScript export or SQL name.'),
				where: filterSchema.optional(),
				groupBy: z.array(z.string()).optional().describe('Columns to count per value of, such as ["status"].'),
			},
			annotations: { title: 'Count rows', ...readOnly },
		},
		(input) =>
			run(async () => {
				const { project, model, database } = await session.db();
				const table = findTable(model, input.table);
				const orm = await project.import<Orm>('drizzle-orm');
				const drizzleTable = project.exports[table.key];
				const columns = orm.getTableColumns(drizzleTable);
				const where = toCondition(input.where as Filter | undefined, table, columns, orm, model.dialect);
				const groups = (input.groupBy ?? []).map((name) => findColumn(table, name));
				type Chain = Promise<unknown[]> & {
					where(condition: unknown): Chain;
					groupBy(...columns: unknown[]): Chain;
					orderBy(...columns: unknown[]): Chain;
					limit(n: number): Chain;
				};
				const rows = (await database.readOnly(async (db) => {
					const fields = Object.fromEntries(groups.map((column) => [column.key, columns[column.key]]));
					let query = db.select({ ...fields, count: orm.count() }).from(drizzleTable) as unknown as Chain;
					if (where) query = query.where(where);
					if (groups.length > 0) {
						query = query
							.groupBy(...groups.map((column) => columns[column.key]))
							.orderBy(orm.desc(orm.count()))
							.limit(maxRows);
					}
					return query;
				})) as Array<Record<string, unknown>>;
				if (groups.length === 0) {
					const total = Number(rows[0]?.count ?? 0);
					return {
						text: `${table.key}: ${total.toLocaleString('en')} rows.`,
						data: { table: table.key, count: total },
					};
				}
				const keys = [...groups.map((column) => column.key), 'count'];
				const values = rows.map((row) =>
					keys.map((key) => (key !== 'count' && isSecret(key, format) ? '[redacted]' : plain(row[key], format))),
				);
				return {
					text: markdownTable(keys, values),
					data: {
						table: table.key,
						groups: values.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i]]))),
					},
				};
			}),
	);

	server.registerTool(
		'query',
		{
			title: 'Run SQL',
			description: `Runs one SQL statement in a read-only transaction and returns up to ${maxRows} rows. Use $1, $2 (Postgres) or ? (SQLite) with \`params\` for values. SQL uses table and column SQL names, not TypeScript keys.`,
			inputSchema: {
				sql: z.string().describe('One statement, such as a SELECT.'),
				params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
				limit: z.number().int().min(1).max(maxRows).optional().describe(`Rows to return, up to ${maxRows}.`),
			},
			annotations: { title: 'Run SQL', ...readOnly },
		},
		(input) =>
			run(async () => {
				const { database } = await session.db();
				const result = await database.read(input.sql, input.params ?? [], input.limit ?? maxRows);
				const rows = result.rows.map((row) =>
					row.map((value, i) =>
						value !== null && isSecret(result.columns[i] ?? '', format) ? '[redacted]' : plain(value, format),
					),
				);
				const note = result.truncated
					? `\n\nShowing the first ${rows.length} rows; add LIMIT or filters to narrow it.`
					: '';
				const text = result.columns.length
					? `${markdownTable(result.columns, rows)}${note}`
					: 'The statement returned no rows.';
				return { text, data: { columns: result.columns, rows, truncated: result.truncated } };
			}),
	);

	server.registerTool(
		'explain',
		{
			title: 'Explain a query',
			description:
				'Shows the plan the database would use for a query, to check that indexes are used. With `analyze` on Postgres, runs the query (read-only) and reports real timings.',
			inputSchema: {
				sql: z.string(),
				params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
				analyze: z.boolean().optional().describe('Postgres only: run it and show actual rows and timings.'),
			},
			annotations: { title: 'Explain a query', ...readOnly },
		},
		(input) =>
			run(async () => {
				const { model, database } = await session.db();
				if (model.dialect === 'postgresql') {
					const options = input.analyze ? 'analyze, buffers, format text' : 'format text';
					const result = await database.read(`explain (${options}) ${input.sql}`, input.params ?? [], 10_000);
					return { text: result.rows.map((row) => String(row[0])).join('\n') };
				}
				const result = await database.read(`explain query plan ${input.sql}`, input.params ?? [], 10_000);
				const depth = new Map<number, number>();
				const lines = result.rows.map(([id, parent, , detail]) => {
					const level = (depth.get(Number(parent)) ?? -1) + 1;
					depth.set(Number(id), level);
					return `${'  '.repeat(level)}${String(detail)}`;
				});
				return { text: lines.join('\n') };
			}),
	);

	server.registerTool(
		'drift',
		{
			title: 'Compare schema and database',
			description:
				'Compares the Drizzle schema with the live database: tables and columns on one side only, and columns whose type or nullability differ. Use it when queries fail on columns the code expects, or after changing the schema.',
			inputSchema: {},
			annotations: { title: 'Compare schema and database', ...readOnly },
		},
		() =>
			run(async () => {
				const { project, model, database } = await session.db();
				const drift = await findDrift(project, model, database);
				return { text: describeDrift(drift), data: { ...drift } };
			}),
	);

	server.registerTool(
		'migrations',
		{
			title: 'Migration status',
			description:
				'Lists the migrations drizzle-kit generated, and whether each has been applied to the database, is pending, or was edited after it was applied.',
			inputSchema: {},
			annotations: { title: 'Migration status', ...readOnly },
		},
		() =>
			run(async () => {
				const { project, model, database } = await session.db();
				const status = await migrationStatus(project, model.dialect, database);
				return { text: describeMigrations(status), data: { ...status } };
			}),
	);

	if (options.allowWrites) {
		server.registerTool(
			'execute',
			{
				title: 'Change data',
				description:
					'Runs one SQL statement that changes data, such as INSERT, UPDATE or DELETE, and commits it. Prefer RETURNING to see what changed. Only available because the server was started with --allow-writes.',
				inputSchema: {
					sql: z.string(),
					params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
				},
				annotations: { title: 'Change data', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
			},
			(input) =>
				run(async () => {
					const { database } = await session.db();
					const result = await database.write(input.sql, input.params ?? [], maxRows);
					const rows = result.rows.map((row) => row.map((value) => plain(value, format)));
					const changed = result.changed !== undefined ? `${result.changed} rows changed.` : 'Done.';
					const text = result.columns.length ? `${changed}\n\n${markdownTable(result.columns, rows)}` : changed;
					return { text, data: { changed: result.changed ?? null, columns: result.columns, rows } };
				}),
		);
	}

	server.registerResource(
		'schema',
		'drizzle://schema',
		{
			title: 'Drizzle schema',
			description: 'Every table in the schema, with its columns and relations.',
			mimeType: 'text/markdown',
		},
		async (uri) => {
			const { model } = await session.current();
			const text = [describeSchema(model), ...model.tables.map(describeTable)].join('\n\n');
			return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
		},
	);

	return {
		server,
		async close() {
			await server.close();
			await session.closeDatabase();
		},
	};
}
