/**
 * Builds the fixture blog databases: the schema applied with drizzle-kit,
 * then a few users, posts, tags and comments.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtures = {
	pg: fileURLToPath(new URL('../fixtures/blog-pg/', import.meta.url)),
	sqlite: fileURLToPath(new URL('../fixtures/blog-sqlite/', import.meta.url)),
};

const users = [
	{ email: 'ada@example.com', displayName: 'Ada', role: 'admin', passwordHash: '$argon2id$ada' },
	{ email: 'grace@example.com', displayName: 'Grace', role: 'author', passwordHash: '$argon2id$grace' },
	{ email: 'linus@example.com', displayName: 'Linus', role: 'reader', passwordHash: '$argon2id$linus' },
] as const;

const posts = [
	{
		authorId: 1,
		title: 'Hello Drizzle',
		body: 'First post',
		published: true,
		rating: '4.5',
		metadata: { tags: ['intro'] },
	},
	{
		authorId: 1,
		title: 'Relations explained',
		body: 'One and many',
		published: true,
		rating: '5.0',
		metadata: { tags: ['guide'] },
	},
	{
		authorId: 2,
		title: 'Draft about migrations',
		body: 'x'.repeat(2000),
		published: false,
		rating: null,
		metadata: null,
	},
	{ authorId: 2, title: 'Indexes matter', body: 'Use them', published: true, rating: '3.5', metadata: { tags: [] } },
	{
		authorId: 2,
		title: 'Postgres or SQLite?',
		body: 'Both',
		published: true,
		rating: '4.0',
		metadata: { tags: ['db'] },
	},
];

const comments = [
	{ postId: 1, authorId: 2, body: 'Nice intro' },
	{ postId: 1, authorId: 3, body: 'Thanks!' },
	{ postId: 2, authorId: 3, body: 'Very clear' },
	{ postId: 5, authorId: null, body: 'Anonymous take' },
];

export interface Blog {
	/** A PGlite data folder or SQLite file. */
	location: string;
	cleanup(): Promise<void>;
}

export async function createPgBlog(): Promise<Blog> {
	const dir = await mkdtemp(join(tmpdir(), 'drizzle-mcp-pg-'));
	const { PGlite } = await import('@electric-sql/pglite');
	const { drizzle } = await import('drizzle-orm/pglite');
	const { pushSchema } = await import('drizzle-kit/api');
	const schema = await import('../fixtures/blog-pg/schema.js');
	const client = new PGlite(dir);
	const db = drizzle(client, { schema });
	await (await pushSchema(schema, db as never)).apply();
	await db.insert(schema.users).values([...users]);
	await db.insert(schema.posts).values(posts);
	await db.insert(schema.tags).values([{ name: 'intro' }, { name: 'guide' }]);
	await db.insert(schema.postTags).values([
		{ postId: 1, tagId: 1 },
		{ postId: 2, tagId: 2 },
	]);
	await db.insert(schema.comments).values(comments);
	await client.close();
	return { location: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function createSqliteBlog(): Promise<Blog> {
	const dir = await mkdtemp(join(tmpdir(), 'drizzle-mcp-sqlite-'));
	const file = join(dir, 'blog.db');
	// drizzle-kit's push runs its DDL through libsql.
	const { createClient } = await import('@libsql/client');
	const { drizzle } = await import('drizzle-orm/libsql');
	const { pushSQLiteSchema } = await import('drizzle-kit/api');
	const schema = await import('../fixtures/blog-sqlite/schema.js');
	const client = createClient({ url: `file:${file}` });
	const db = drizzle(client, { schema });
	await (await pushSQLiteSchema(schema, db)).apply();
	await db.insert(schema.users).values([...users]);
	await db
		.insert(schema.posts)
		.values(posts.map((post) => ({ ...post, rating: post.rating === null ? null : Number(post.rating) })));
	await db.insert(schema.comments).values(comments);
	client.close();
	return { location: file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
