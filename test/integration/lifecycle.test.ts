import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgBlog, fixtures } from '../support/blog.js';
import { connectClient } from '../support/client.js';
import { copyFixture } from '../support/workspace.js';

const addSlug = (source: string) =>
	source.replace("title: text('title').notNull(),", "title: text('title').notNull(),\n\t\tslug: text('slug'),");

describe('reloading', () => {
	it('picks up schema edits without a restart', async () => {
		const blog = await createPgBlog();
		const project = await copyFixture(fixtures.pg);
		const mcp = await connectClient({ config: project.config, url: blog.location });
		try {
			expect((await mcp.call('schema', { table: 'posts' })).text).not.toContain('slug');
			await project.editSchema(addSlug);
			expect((await mcp.call('schema', { table: 'posts' })).text).toContain('| slug | text | yes |');
			// The database hasn't caught up, and drift says so.
			expect((await mcp.call('drift')).data).toMatchObject({
				inSync: false,
				missingColumns: [{ table: 'posts', column: 'slug', schema: 'text' }],
			});
		} finally {
			await mcp.close();
			await project.cleanup();
			await blog.cleanup();
		}
	});

	it('reports a broken schema file and recovers when it is fixed', async () => {
		const blog = await createPgBlog();
		const project = await copyFixture(fixtures.pg);
		const mcp = await connectClient({ config: project.config, url: blog.location });
		try {
			const original = await readFile(join(project.dir, 'schema.ts'), 'utf8');
			await project.editSchema((source) => `${source}\nexport const broken = ;`);
			expect((await mcp.call('schema')).isError).toBe(true);
			await project.editSchema(() => original);
			expect((await mcp.call('schema')).isError).toBe(false);
		} finally {
			await mcp.close();
			await project.cleanup();
			await blog.cleanup();
		}
	});
});

describe('drift', () => {
	it('lists every kind of difference', async () => {
		const blog = await createPgBlog();
		const { PGlite } = await import('@electric-sql/pglite');
		const db = new PGlite(blog.location);
		await db.exec(`
			alter table users add column legacy text;
			alter table comments alter column body drop not null;
			alter table tags alter column name type varchar(50);
			alter table posts drop column rating;
			create table audit_log (id integer);
		`);
		await db.close();
		const mcp = await connectClient({ config: `${fixtures.pg}drizzle.config.ts`, url: blog.location });
		try {
			const drift = await mcp.call('drift');
			expect(drift.data).toEqual({
				inSync: false,
				missingTables: [],
				extraTables: ['audit_log'],
				missingColumns: [{ table: 'posts', column: 'rating', schema: 'numeric(3, 1)' }],
				extraColumns: [{ table: 'users', column: 'legacy', database: 'text' }],
				typeChanges: [{ table: 'tags', column: 'name', schema: 'text', database: 'character varying(50)' }],
				nullabilityChanges: [{ table: 'comments', column: 'body', schema: 'not null', database: 'nullable' }],
			});
			expect(drift.text).toContain('- tags.name: text in the schema, character varying(50) in the database');
		} finally {
			await mcp.close();
			await blog.cleanup();
		}
	});
});

describe('migrations', () => {
	const dialects = [
		{
			name: 'postgres',
			fixture: fixtures.pg,
			location: (dir: string) => join(dir, '.pglite'),
			async migrate(location: string, folder: string) {
				const { PGlite } = await import('@electric-sql/pglite');
				const { drizzle } = await import('drizzle-orm/pglite');
				const { migrate } = await import('drizzle-orm/pglite/migrator');
				const client = new PGlite(location);
				await migrate(drizzle(client), { migrationsFolder: folder });
				await client.close();
			},
		},
		{
			name: 'sqlite',
			fixture: fixtures.sqlite,
			location: (dir: string) => join(dir, 'blog.db'),
			async migrate(location: string, folder: string) {
				const { createClient } = await import('@libsql/client');
				const { drizzle } = await import('drizzle-orm/libsql');
				const { migrate } = await import('drizzle-orm/libsql/migrator');
				const client = createClient({ url: `file:${location}` });
				await migrate(drizzle(client), { migrationsFolder: folder });
				client.close();
			},
		},
	];

	it.each(dialects)('tells applied, pending and edited migrations apart ($name)', async (dialect) => {
		const project = await copyFixture(dialect.fixture);
		const location = dialect.location(project.dir);
		try {
			await project.drizzleKit('generate');
			await dialect.migrate(location, join(project.dir, 'drizzle'));
			await project.editSchema(addSlug);
			await project.drizzleKit('generate');

			const mcp = await connectClient({ config: project.config, url: location });
			try {
				const status = await mcp.call('migrations');
				const [first, second] = (status.data?.migrations ?? []) as Array<{ tag: string; status: string }>;
				expect([first?.status, second?.status]).toEqual(['applied', 'pending']);
				expect(status.text).toMatch(/^2 migrations in drizzle\/: 1 applied, 1 pending\./);
				expect(status.text).toContain('Apply pending migrations with `drizzle-kit migrate`.');

				const sql = (await readdir(join(project.dir, 'drizzle'))).find((file) => file.startsWith('0000'));
				await writeFile(join(project.dir, 'drizzle', String(sql)), '-- edited afterwards\n', { flag: 'a' });
				const edited = await mcp.call('migrations');
				const migrations = (edited.data?.migrations ?? []) as Array<{ status: string }>;
				expect(migrations[0]?.status).toBe('edited');
				expect(edited.text).toContain(`Edited after being applied: ${first?.tag}.`);
			} finally {
				await mcp.close();
			}
		} finally {
			await project.cleanup();
		}
	});

	it('explains when there are no migrations yet', async () => {
		const blog = await createPgBlog();
		const project = await copyFixture(fixtures.pg);
		const mcp = await connectClient({ config: project.config, url: blog.location });
		try {
			const result = await mcp.call('migrations');
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(/^There's no migration journal at .*Generate migrations with `drizzle-kit generate`/);
		} finally {
			await mcp.close();
			await project.cleanup();
			await blog.cleanup();
		}
	});
});
