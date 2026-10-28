/**
 * Every driver the server supports, each set up against the same seeded blog.
 * `pg` and `postgres` reach PGlite over the real Postgres wire protocol.
 */

import { createServer as createNetServer } from 'node:net';
import type { ServerOptions } from '../../src/server.js';
import { createPgBlog, createSqliteBlog, fixtures } from './blog.js';

export interface DriverSetup {
	name: 'pglite' | 'pg' | 'postgres' | 'better-sqlite3' | 'libsql';
	dialect: 'postgresql' | 'sqlite';
	start(extra?: ServerOptions): Promise<{ options: ServerOptions; stop(): Promise<void> }>;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createNetServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
		});
	});
}

const pgConfig = `${fixtures.pg}drizzle.config.ts`;
const sqliteConfig = `${fixtures.sqlite}drizzle.config.ts`;

async function overSocket(driver: 'pg' | 'postgres', extra: ServerOptions = {}) {
	const blog = await createPgBlog();
	const { PGlite } = await import('@electric-sql/pglite');
	const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
	const db = new PGlite(blog.location);
	const port = await freePort();
	const socket = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
	await socket.start();
	return {
		options: { config: pgConfig, url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, driver, ...extra },
		async stop() {
			await socket.stop();
			await db.close();
			await blog.cleanup();
		},
	};
}

export const drivers: DriverSetup[] = [
	{
		name: 'pglite',
		dialect: 'postgresql',
		async start(extra = {}) {
			const blog = await createPgBlog();
			return { options: { config: pgConfig, url: blog.location, ...extra }, stop: blog.cleanup };
		},
	},
	{ name: 'pg', dialect: 'postgresql', start: (extra) => overSocket('pg', extra) },
	{ name: 'postgres', dialect: 'postgresql', start: (extra) => overSocket('postgres', extra) },
	{
		name: 'better-sqlite3',
		dialect: 'sqlite',
		async start(extra = {}) {
			const blog = await createSqliteBlog();
			return {
				options: { config: sqliteConfig, url: blog.location, driver: 'better-sqlite3', ...extra },
				stop: blog.cleanup,
			};
		},
	},
	{
		name: 'libsql',
		dialect: 'sqlite',
		async start(extra = {}) {
			const blog = await createSqliteBlog();
			return { options: { config: sqliteConfig, url: blog.location, driver: 'libsql', ...extra }, stop: blog.cleanup };
		},
	},
];
