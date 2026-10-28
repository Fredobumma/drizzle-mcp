import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient } from '../support/client.js';
import { drivers } from '../support/drivers.js';

describe.each(drivers)('$name', ({ name, dialect, start }) => {
	let mcp: Awaited<ReturnType<typeof connectClient>>;
	let stop: () => Promise<void>;
	const param = dialect === 'postgresql' ? '$1' : '?';

	beforeAll(async () => {
		const started = await start();
		stop = started.stop;
		mcp = await connectClient(started.options);
	}, 60_000);

	afterAll(async () => {
		await mcp?.close();
		await stop?.();
	});

	it('lists the tools, with execute only when writes are allowed', async () => {
		const { tools } = await mcp.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			'browse',
			'count',
			'drift',
			'explain',
			'migrations',
			'query',
			'schema',
		]);
		expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
	});

	it('describes the schema with TypeScript and SQL names', async () => {
		const overview = await mcp.call('schema');
		expect(overview.text).toContain('| posts | posts | id, authorId, title, body, published, rating, metadata');
		const posts = await mcp.call('schema', { table: 'posts' });
		expect(posts.text).toContain('| authorId (author_id) | integer | no |  | → users.id, on delete cascade |');
		expect(posts.text).toContain('- author: one users on posts.authorId = users.id');
		expect(posts.text).toContain('- comments: many comments on posts.id = comments.postId');
		expect(posts.text).toContain('- posts_author_idx: (author_id)');
	});

	it('finds tables by SQL name too, and explains unknown ones', async () => {
		expect((await mcp.call('schema', { table: 'users' })).text).toContain('| displayName (display_name) |');
		const missing = await mcp.call('schema', { table: 'people' });
		expect(missing.isError).toBe(true);
		expect(missing.text).toBe(
			`There's no table called "people". The schema has: ${dialect === 'postgresql' ? 'comments, posts, postTags, tags, users' : 'comments, posts, users'}.`,
		);
	});

	it('browses rows with filters, sorting, columns and relations', async () => {
		const result = await mcp.call('browse', {
			table: 'posts',
			columns: ['id', 'title'],
			where: { published: true, or: [{ rating: { gte: 4.5 } }, { title: { ilike: '%INDEX%' } }] },
			orderBy: [{ column: 'id', direction: 'desc' }],
			with: { author: { columns: ['displayName', 'passwordHash'] }, comments: { limit: 1, columns: ['body'] } },
		});
		expect(result.isError).toBe(false);
		expect(result.data).toEqual({
			table: 'posts',
			total: 3,
			offset: 0,
			rows: [
				{ id: 4, title: 'Indexes matter', author: { displayName: 'Grace', passwordHash: '[redacted]' }, comments: [] },
				{
					id: 2,
					title: 'Relations explained',
					author: { displayName: 'Ada', passwordHash: '[redacted]' },
					comments: [{ body: 'Very clear' }],
				},
				{
					id: 1,
					title: 'Hello Drizzle',
					author: { displayName: 'Ada', passwordHash: '[redacted]' },
					comments: [{ body: 'Nice intro' }],
				},
			],
		});
	});

	it('pages by primary key and says how to get more', async () => {
		const first = await mcp.call('browse', { table: 'comments', limit: 2, columns: ['id'] });
		expect(first.text.split('\n')[0]).toBe('comments: rows 1–2 of 4. Pass offset 2 for more.');
		const next = await mcp.call('browse', { table: 'comments', limit: 2, offset: 2, columns: ['id'] });
		expect(next.data?.rows).toEqual([{ id: 3 }, { id: 4 }]);
	});

	it('cuts long text and filters on nulls', async () => {
		const result = await mcp.call('browse', { table: 'posts', where: { metadata: null }, columns: ['body'] });
		expect(result.data?.rows).toEqual([{ body: `${'x'.repeat(500)}… (1,500 more characters)` }]);
	});

	it('explains a bad filter', async () => {
		const result = await mcp.call('browse', { table: 'posts', where: { author: 1 } });
		expect(result).toMatchObject({ isError: true });
		expect(result.text).toMatch(/^posts has no column "author"\. Its columns are: id, authorId/);
		const relation = await mcp.call('browse', { table: 'posts', with: { writer: true } });
		expect(relation.text).toBe(
			'posts has no relation "writer". Its relations are: author, comments' +
				(dialect === 'postgresql' ? ', postTags.' : '.'),
		);
	});

	it('counts, overall and per value', async () => {
		expect((await mcp.call('count', { table: 'posts', where: { published: false } })).data).toEqual({
			table: 'posts',
			count: 1,
		});
		const byAuthor = await mcp.call('count', { table: 'posts', groupBy: ['authorId'] });
		expect(byAuthor.data?.groups).toEqual([
			{ authorId: 2, count: 3 },
			{ authorId: 1, count: 2 },
		]);
	});

	it('runs SQL with parameters, capping rows and hiding secrets', async () => {
		const joined = await mcp.call('query', {
			sql: `select p.title, u.display_name, u.password_hash from posts p join users u on u.id = p.author_id where u.id = ${param} order by p.id`,
			params: [1],
		});
		expect(joined.data).toEqual({
			columns: ['title', 'display_name', 'password_hash'],
			rows: [
				['Hello Drizzle', 'Ada', '[redacted]'],
				['Relations explained', 'Ada', '[redacted]'],
			],
			truncated: false,
		});
		const capped = await mcp.call('query', { sql: 'select id from posts order by id', limit: 2 });
		expect(capped.data).toMatchObject({ rows: [[1], [2]], truncated: true });
		expect(capped.text).toContain('Showing the first 2 rows');
	});

	it('explains a query plan', async () => {
		const plan = await mcp.call('explain', { sql: 'select * from posts where author_id = 1' });
		expect(plan.isError).toBe(false);
		expect(plan.text).toMatch(dialect === 'postgresql' ? /posts_author_idx|Scan on posts/ : /posts_author_idx/);
	});

	it('finds the schema and database in sync', async () => {
		const drift = await mcp.call('drift');
		expect(drift.text).toBe('The database matches the Drizzle schema: same tables, columns, types and nullability.');
	});

	it('shares the schema as a resource', async () => {
		const resource = await mcp.client.readResource({ uri: 'drizzle://schema' });
		const content = resource.contents[0] as { text: string };
		expect(content.text).toContain('## posts');
	});

	it(`uses the ${name} driver`, () => {
		// The suite name records which driver ran; this keeps the table of results readable.
		expect(name).toBeTruthy();
	});
});
