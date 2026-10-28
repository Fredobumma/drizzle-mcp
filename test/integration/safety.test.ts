import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient } from '../support/client.js';
import { drivers } from '../support/drivers.js';

describe.each(drivers)('$name, read-only', ({ dialect, start }) => {
	let mcp: Awaited<ReturnType<typeof connectClient>>;
	let stop: () => Promise<void>;

	beforeAll(async () => {
		const started = await start();
		stop = started.stop;
		mcp = await connectClient(started.options);
	}, 60_000);

	afterAll(async () => {
		await mcp?.close();
		await stop?.();
	});

	const attempts = [
		"update users set role = 'admin'",
		'delete from comments',
		'with gone as (delete from comments returning id) select count(*) from gone',
		'create table intruder (id integer)',
		'drop table comments',
	];

	it.each(attempts)('refuses %s', async (sql) => {
		const result = await mcp.call('query', { sql });
		expect(result.isError).toBe(true);
		// SQLite has no data-modifying CTEs, so that one fails as a syntax error instead.
		expect(result.text).toMatch(/read-only|Writes are turned off|syntax error/i);
	});

	it('refuses several statements, so nothing can escape the transaction', async () => {
		for (const sql of [
			'select 1; delete from comments',
			'select 1; commit; drop table comments',
			"select ';'; drop table posts",
		]) {
			const result = await mcp.call('query', { sql });
			expect(result).toMatchObject({ isError: true, text: 'Send one statement at a time; this SQL has several.' });
		}
	});

	it('allows semicolons inside strings and a trailing one', async () => {
		const result = await mcp.call('query', { sql: "select 'a;b' as text; -- done" });
		expect(result.data?.rows).toEqual([['a;b']]);
	});

	it('left every row in place', async () => {
		expect((await mcp.call('count', { table: 'comments' })).data).toEqual({ table: 'comments', count: 4 });
		const roles = await mcp.call('count', { table: 'users', where: { role: 'admin' } });
		expect(roles.data?.count).toBe(1);
		const intruder = await mcp.call('query', {
			sql:
				dialect === 'postgresql'
					? "select count(*)::int from information_schema.tables where table_name = 'intruder'"
					: "select count(*) from sqlite_master where name = 'intruder'",
		});
		expect(intruder.data?.rows).toEqual([[0]]);
	});
});

describe.each(drivers)('$name, with writes allowed', ({ start }) => {
	let mcp: Awaited<ReturnType<typeof connectClient>>;
	let stop: () => Promise<void>;

	beforeAll(async () => {
		const started = await start({ allowWrites: true });
		stop = started.stop;
		mcp = await connectClient(started.options);
	}, 60_000);

	afterAll(async () => {
		await mcp?.close();
		await stop?.();
	});

	it('adds execute, which changes data and returns rows', async () => {
		const { tools } = await mcp.client.listTools();
		expect(tools.find((tool) => tool.name === 'execute')?.annotations).toMatchObject({ destructiveHint: true });
		const updated = await mcp.call('execute', {
			sql: "update posts set title = 'Renamed' where id = 1 returning id, title",
		});
		expect(updated.isError).toBe(false);
		expect(updated.data?.rows).toEqual([[1, 'Renamed']]);
		const deleted = await mcp.call('execute', { sql: 'delete from comments where id = 4' });
		expect(deleted.data?.changed).toBe(1);
		expect((await mcp.call('count', { table: 'comments' })).data?.count).toBe(3);
	});

	it('keeps query read-only and points at execute', async () => {
		const result = await mcp.call('query', { sql: 'delete from comments' });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/read-only/i);
	});
});
