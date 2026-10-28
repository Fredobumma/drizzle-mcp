/**
 * Connects to the project's database with whichever driver it uses, and runs
 * statements safely: one at a time, read-only unless writes were allowed, with
 * a time limit, and never fetching more rows than asked for.
 */

import type { SqlDialect } from './model.js';
import { type Project, projectPath } from './project.js';
import { firstKeyword, isQuery, singleStatement, stripLiterals } from './sql.js';

export interface Result {
	columns: string[];
	rows: unknown[][];
	/** `true` when the statement returned more rows than the limit. */
	truncated: boolean;
	/** Rows a write changed, when the driver reports it. */
	changed?: number;
}

/** A Drizzle database. Typed loosely: it comes from the project's own drizzle-orm. */
export type DrizzleDb = {
	query: Record<string, { findMany(config?: object): Promise<unknown[]> }>;
	select(fields?: object): {
		from(table: unknown): { where(condition: unknown): Promise<unknown[]> } & Promise<unknown[]>;
	};
	execute?(query: unknown): Promise<unknown>;
	all?(query: unknown): unknown;
	transaction<T>(fn: (tx: DrizzleDb) => Promise<T>, config?: object): Promise<T>;
};

export type DriverName = 'pg' | 'postgres' | 'pglite' | 'better-sqlite3' | 'libsql';

export interface Database {
	dialect: SqlDialect;
	driver: DriverName;
	/** A Drizzle database over the project's schema, for relational queries. */
	db: DrizzleDb;
	/** Runs one statement that can't change anything, returning at most `limit` rows. */
	read(sql: string, params: unknown[], limit: number): Promise<Result>;
	/** Runs one statement that may change data. Throws unless writes were allowed. */
	write(sql: string, params: unknown[], limit: number): Promise<Result>;
	/** Runs `fn` with a Drizzle database that can't write. */
	readOnly<T>(fn: (db: DrizzleDb) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

export interface ConnectOptions {
	/** Overrides `dbCredentials` with a connection string or file. */
	url?: string;
	/** Picks the driver instead of using the one the project has installed. */
	driver?: DriverName;
	allowWrites?: boolean;
	/** Statement time limit in milliseconds (Postgres). */
	timeout?: number;
}

const CURSOR = 'drizzle_mcp_cursor';

function noWrites(allowWrites = false): never {
	throw new Error(
		allowWrites
			? 'This tool is read-only. Use `execute` to change data.'
			: 'Writes are turned off. Start drizzle-mcp with --allow-writes to change data.',
	);
}

/** Statements a read-only SQLite connection may run. PRAGMA only when it reads a setting. */
function sqliteReads(sql: string): boolean {
	const keyword = firstKeyword(sql);
	if (keyword === 'pragma') return !stripLiterals(sql).includes('=');
	return ['select', 'with', 'values', 'explain'].includes(keyword);
}

function drizzleConfig(project: Project) {
	return { schema: project.exports, ...(project.config.casing ? { casing: project.config.casing } : {}) };
}

/** Picks the driver: `pglite` if the config says so, otherwise whichever the project has installed. */
function pickDriver(project: Project, dialect: SqlDialect, url: string | undefined, given?: DriverName): DriverName {
	if (given) return given;
	if (dialect === 'postgresql') {
		if (project.config.driver === 'pglite') return 'pglite';
		if (project.has('pg')) return 'pg';
		if (project.has('postgres')) return 'postgres';
		throw new Error('Install `pg` or `postgres` in the project so drizzle-mcp can connect, as drizzle-kit needs too.');
	}
	const remote = url !== undefined && /^(?:libsql|https?|wss?):/.test(url);
	if (project.config.dialect === 'turso' || remote) return 'libsql';
	if (project.has('better-sqlite3')) return 'better-sqlite3';
	if (project.has('@libsql/client')) return 'libsql';
	throw new Error('Install `better-sqlite3` or `@libsql/client` in the project so drizzle-mcp can open the database.');
}

export async function connect(project: Project, dialect: SqlDialect, options: ConnectOptions = {}): Promise<Database> {
	const credentials = { ...project.config.dbCredentials };
	if (options.url) credentials.url = options.url;
	const url = typeof credentials.url === 'string' ? credentials.url : undefined;
	const driver = pickDriver(project, dialect, url, options.driver);
	const settings = {
		allowWrites: options.allowWrites ?? false,
		timeout: Math.max(1, Math.floor(options.timeout ?? 15_000)),
	};

	switch (driver) {
		case 'pg':
			return connectPg(project, credentials, settings);
		case 'postgres':
			return connectPostgresJs(project, credentials, settings);
		case 'pglite':
			return connectPglite(project, url, settings);
		case 'better-sqlite3':
			return connectBetterSqlite(project, url, settings);
		case 'libsql':
			return connectLibsql(project, credentials, settings);
	}
}

interface Settings {
	allowWrites: boolean;
	timeout: number;
}

/** What a Postgres driver needs to run the shared cursor logic. */
interface PgSession {
	run(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: unknown[][]; changed?: number }>;
}

/**
 * Runs `sql` in an open transaction. Queries go through a cursor so only
 * `limit + 1` rows ever leave the server; other statements run directly.
 */
async function pgStatement(session: PgSession, sql: string, params: unknown[], limit: number): Promise<Result> {
	if (isQuery(sql)) {
		await session.run('SAVEPOINT drizzle_mcp');
		try {
			await session.run(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${sql}`, params);
			const { columns, rows } = await session.run(`FETCH FORWARD ${limit + 1} FROM ${CURSOR}`);
			await session.run(`CLOSE ${CURSOR}`);
			return { columns, rows: rows.slice(0, limit), truncated: rows.length > limit };
		} catch (error) {
			// Some queries can't sit behind a cursor, such as a WITH that writes. Run those as they are.
			await session.run('ROLLBACK TO SAVEPOINT drizzle_mcp');
			if (!/cursor/i.test(String((error as Error).message))) throw error;
		}
	}
	const { columns, rows, changed } = await session.run(sql, params);
	return {
		columns,
		rows: rows.slice(0, limit),
		truncated: rows.length > limit,
		...(changed !== undefined ? { changed } : {}),
	};
}

interface PgClient {
	query(
		config: object | string,
	): Promise<{ fields?: Array<{ name: string }>; rows: unknown[][]; rowCount?: number | null; command?: string }>;
	release(): void;
}

async function connectPg(
	project: Project,
	credentials: Record<string, unknown>,
	settings: Settings,
): Promise<Database> {
	const pg = await project.import<{
		Pool: new (config: object) => { connect(): Promise<PgClient>; end(): Promise<void> };
	}>('pg');
	const { url, ...rest } = credentials;
	const pool = new pg.Pool({
		...(url ? { connectionString: url } : rest),
		max: 3,
		application_name: 'drizzle-mcp',
	});
	const { drizzle } = await project.import<{ drizzle(client: unknown, config: object): DrizzleDb }>(
		'drizzle-orm/node-postgres',
	);
	const db = drizzle(pool, drizzleConfig(project));

	async function inTransaction(sql: string, params: unknown[], limit: number, readOnly: boolean): Promise<Result> {
		const client = await pool.connect();
		const session: PgSession = {
			async run(text, values = []) {
				// Extended mode refuses multiple statements, so nothing can slip out of the transaction.
				const result = await client.query({ text, values, rowMode: 'array', queryMode: 'extended' });
				const changed = result.command && result.command !== 'SELECT' ? (result.rowCount ?? undefined) : undefined;
				return { columns: result.fields?.map((field) => field.name) ?? [], rows: result.rows, changed };
			},
		};
		try {
			await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
			await client.query(`SET LOCAL statement_timeout = ${settings.timeout}`);
			const result = await pgStatement(session, singleStatement(sql), params, limit);
			await client.query(readOnly ? 'ROLLBACK' : 'COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

	return {
		dialect: 'postgresql',
		driver: 'pg',
		db,
		read: (sql, params, limit) => inTransaction(sql, params, limit, true),
		write: (sql, params, limit) => (settings.allowWrites ? inTransaction(sql, params, limit, false) : noWrites()),
		readOnly: (fn) => pgReadOnly(project, db, settings.timeout, fn),
		close: () => pool.end(),
	};
}

/** A Drizzle transaction that can't write, with the statement time limit applied. */
async function pgReadOnly<T>(
	project: Project,
	db: DrizzleDb,
	timeout: number,
	fn: (db: DrizzleDb) => Promise<T>,
): Promise<T> {
	const { sql } = await project.import<{ sql: { raw(text: string): unknown } }>('drizzle-orm');
	return db.transaction(
		async (tx) => {
			await tx.execute?.(sql.raw(`SET LOCAL statement_timeout = ${timeout}`));
			return fn(tx);
		},
		{ accessMode: 'read only' },
	);
}

interface PostgresJsSql {
	(template: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
	unsafe(
		query: string,
		params?: unknown[],
		options?: { prepare?: boolean },
	): Promise<unknown[]> & {
		values(): Promise<unknown[][] & { columns?: Array<{ name: string }>; count?: number; command?: string }>;
	};
	begin<T>(fn: (tx: PostgresJsSql) => Promise<T>): Promise<T>;
	begin<T>(mode: string, fn: (tx: PostgresJsSql) => Promise<T>): Promise<T>;
	end(options?: { timeout?: number }): Promise<void>;
}

async function connectPostgresJs(
	project: Project,
	credentials: Record<string, unknown>,
	settings: Settings,
): Promise<Database> {
	const module = await project.import<{ default?: (...args: unknown[]) => PostgresJsSql }>('postgres');
	const postgres = (module.default ?? module) as (...args: unknown[]) => PostgresJsSql;
	const { url, ...rest } = credentials;
	const options = { max: 3, onnotice: () => {}, connection: { application_name: 'drizzle-mcp' } };
	const client = url ? postgres(url, options) : postgres({ ...rest, ...options });
	const { drizzle } = await project.import<{ drizzle(client: unknown, config: object): DrizzleDb }>(
		'drizzle-orm/postgres-js',
	);
	const db = drizzle(client, drizzleConfig(project));

	function inTransaction(sql: string, params: unknown[], limit: number, readOnly: boolean): Promise<Result> {
		const body = async (tx: PostgresJsSql) => {
			const session: PgSession = {
				async run(text, values = []) {
					const rows = await tx.unsafe(text, values, { prepare: true }).values();
					const changed = rows.command && rows.command !== 'SELECT' ? rows.count : undefined;
					return { columns: rows.columns?.map((column) => column.name) ?? [], rows: [...rows], changed };
				},
			};
			await tx.unsafe(`SET LOCAL statement_timeout = ${settings.timeout}`);
			return pgStatement(session, singleStatement(sql), params, limit);
		};
		return readOnly ? client.begin('read only', body) : client.begin(body);
	}

	return {
		dialect: 'postgresql',
		driver: 'postgres',
		db,
		read: (sql, params, limit) => inTransaction(sql, params, limit, true),
		write: (sql, params, limit) => (settings.allowWrites ? inTransaction(sql, params, limit, false) : noWrites()),
		readOnly: (fn) => pgReadOnly(project, db, settings.timeout, fn),
		close: () => client.end({ timeout: 2 }),
	};
}

interface PgliteTransaction {
	query(
		sql: string,
		params?: unknown[],
		options?: { rowMode?: 'array' | 'object' },
	): Promise<{
		rows: unknown[][];
		fields: Array<{ name: string }>;
		affectedRows?: number;
	}>;
	rollback(): Promise<void>;
}

async function connectPglite(project: Project, url: string | undefined, settings: Settings): Promise<Database> {
	const { PGlite } = await project.import<{
		PGlite: new (
			dataDir?: string,
		) => {
			transaction<T>(fn: (tx: PgliteTransaction) => Promise<T>): Promise<T>;
			close(): Promise<void>;
		};
	}>('@electric-sql/pglite');
	const dataDir = !url || url.startsWith('memory://') || url.startsWith('idb://') ? url : projectPath(project, url);
	const client = new PGlite(dataDir);
	const { drizzle } = await project.import<{ drizzle(client: unknown, config: object): DrizzleDb }>(
		'drizzle-orm/pglite',
	);
	const db = drizzle(client, drizzleConfig(project));

	function inTransaction(sql: string, params: unknown[], limit: number, readOnly: boolean): Promise<Result> {
		return client.transaction(async (tx) => {
			if (readOnly) await tx.query('SET TRANSACTION READ ONLY');
			await tx.query(`SET LOCAL statement_timeout = ${settings.timeout}`);
			const session: PgSession = {
				async run(text, values = []) {
					// `query` uses the extended protocol: one statement only.
					const result = await tx.query(text, values, { rowMode: 'array' });
					return { columns: result.fields.map((field) => field.name), rows: result.rows, changed: result.affectedRows };
				},
			};
			const result = await pgStatement(session, singleStatement(sql), params, limit);
			if (readOnly) await tx.rollback();
			return result;
		});
	}

	return {
		dialect: 'postgresql',
		driver: 'pglite',
		db,
		read: (sql, params, limit) => inTransaction(sql, params, limit, true),
		write: (sql, params, limit) => (settings.allowWrites ? inTransaction(sql, params, limit, false) : noWrites()),
		readOnly: (fn) => pgReadOnly(project, db, settings.timeout, fn),
		close: () => client.close(),
	};
}

/** A SQLite file path from `url`, which may be `file:`-prefixed and relative to the project. */
function sqliteFile(project: Project, url: string | undefined): string {
	if (!url) throw new Error('The Drizzle config has no `dbCredentials.url` for the SQLite file.');
	if (url === ':memory:') return url;
	return projectPath(project, url.replace(/^file:(\/\/)?/, ''));
}

interface BetterStatement {
	reader: boolean;
	readonly: boolean;
	raw(toggle?: boolean): BetterStatement;
	columns(): Array<{ name: string }>;
	iterate(...params: unknown[]): IterableIterator<unknown[]>;
	run(...params: unknown[]): { changes: number };
}

interface BetterDatabase {
	prepare(sql: string): BetterStatement;
	close(): void;
}

async function connectBetterSqlite(project: Project, url: string | undefined, settings: Settings): Promise<Database> {
	const module = await project.import<{ default?: new (file: string, options?: object) => BetterDatabase }>(
		'better-sqlite3',
	);
	const BetterSqlite = (module.default ?? module) as new (file: string, options?: object) => BetterDatabase;
	const file = sqliteFile(project, url);
	// Reads go through a connection SQLite itself keeps read-only.
	const reader = new BetterSqlite(file, { readonly: file !== ':memory:', fileMustExist: file !== ':memory:' });
	const writer = settings.allowWrites ? new BetterSqlite(file, { fileMustExist: file !== ':memory:' }) : null;
	const { drizzle } = await project.import<{ drizzle(client: unknown, config: object): DrizzleDb }>(
		'drizzle-orm/better-sqlite3',
	);
	const db = drizzle(reader, drizzleConfig(project));

	function run(connection: BetterDatabase, sql: string, params: unknown[], limit: number, readOnly: boolean): Result {
		const statement = connection.prepare(singleStatement(sql));
		if (readOnly && !statement.readonly) noWrites(settings.allowWrites);
		if (!statement.reader)
			return { columns: [], rows: [], truncated: false, changed: statement.run(...params).changes };
		statement.raw(true);
		const rows: unknown[][] = [];
		for (const row of statement.iterate(...params)) {
			if (rows.length === limit) return { columns: statement.columns().map((c) => c.name), rows, truncated: true };
			rows.push(row);
		}
		return { columns: statement.columns().map((column) => column.name), rows, truncated: false };
	}

	return {
		dialect: 'sqlite',
		driver: 'better-sqlite3',
		db,
		read: async (sql, params, limit) => run(reader, sql, params, limit, true),
		write: async (sql, params, limit) => (writer ? run(writer, sql, params, limit, false) : noWrites()),
		readOnly: (fn) => fn(db),
		async close() {
			reader.close();
			writer?.close();
		},
	};
}

interface LibsqlResultSet {
	columns: string[];
	rows: Array<ArrayLike<unknown>>;
	rowsAffected: number;
}

interface LibsqlTransaction {
	execute(statement: { sql: string; args: unknown[] }): Promise<LibsqlResultSet>;
	commit(): Promise<void>;
	close(): void;
}

async function connectLibsql(
	project: Project,
	credentials: Record<string, unknown>,
	settings: Settings,
): Promise<Database> {
	const { createClient } = await project.import<{
		createClient(config: object): { transaction(mode: string): Promise<LibsqlTransaction>; close(): void };
	}>('@libsql/client');
	const raw = String(credentials.url ?? '');
	const url =
		/^(?:libsql|https?|wss?|file):/.test(raw) || raw === ':memory:' ? raw : `file:${projectPath(project, raw)}`;
	const client = createClient({ url, ...(credentials.authToken ? { authToken: credentials.authToken } : {}) });
	const { drizzle } = await project.import<{ drizzle(client: unknown, config: object): DrizzleDb }>(
		'drizzle-orm/libsql',
	);
	const db = drizzle(client, drizzleConfig(project));

	async function run(sql: string, params: unknown[], limit: number, readOnly: boolean): Promise<Result> {
		const statement = singleStatement(sql);
		// libsql's read transactions don't refuse writes; they only roll them back. Refuse them first.
		if (readOnly && !sqliteReads(statement)) noWrites(settings.allowWrites);
		const tx = await client.transaction(readOnly ? 'read' : 'write');
		try {
			// libsql can't stream, so queries are capped with LIMIT instead of a cursor.
			const capped = isQuery(statement) ? `SELECT * FROM (${statement}) LIMIT ${limit + 1}` : statement;
			const result = await tx.execute({ sql: capped, args: params }).catch((error: unknown) => {
				if (capped === statement) throw error;
				return tx.execute({ sql: statement, args: params });
			});
			// A WITH … DELETE gets this far; it's rolled back with the transaction.
			if (readOnly && result.rowsAffected > 0 && firstKeyword(statement) !== 'select') noWrites(settings.allowWrites);
			if (!readOnly) await tx.commit();
			const rows = result.rows.map((row) => Array.from(row));
			return {
				columns: result.columns,
				rows: rows.slice(0, limit),
				truncated: rows.length > limit,
				...(result.columns.length === 0 ? { changed: result.rowsAffected } : {}),
			};
		} finally {
			tx.close();
		}
	}

	return {
		dialect: 'sqlite',
		driver: 'libsql',
		db,
		read: (sql, params, limit) => run(sql, params, limit, true),
		write: (sql, params, limit) => (settings.allowWrites ? run(sql, params, limit, false) : noWrites()),
		readOnly: (fn) => fn(db),
		async close() {
			client.close();
		},
	};
}
