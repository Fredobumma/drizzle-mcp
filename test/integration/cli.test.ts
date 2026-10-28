import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { createPgBlog, fixtures } from '../support/blog.js';

const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
// An absolute loader path, so the CLI can run from any folder.
const tsx = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
const node = (args: string[]) => [process.execPath, ['--import', tsx, cli, ...args]] as const;

describe('drizzle-mcp over stdio', () => {
	it('serves a client while project output goes to stderr', async () => {
		const blog = await createPgBlog();
		const [command, args] = node(['--config', `${fixtures.pg}drizzle.config.ts`, '--url', blog.location]);
		const transport = new StdioClientTransport({
			command,
			args: [...args],
			env: { ...(process.env as Record<string, string>), BLOG_NOISY: '1' },
			stderr: 'pipe',
		});
		let stderr = '';
		transport.stderr?.on('data', (chunk) => {
			stderr += chunk;
		});
		const client = new Client({ name: 'cli-test', version: '1.0.0' });
		try {
			await client.connect(transport);
			const { tools } = await client.listTools();
			expect(tools).toHaveLength(7);
			const result = (await client.callTool({ name: 'count', arguments: { table: 'posts' } })) as {
				content: Array<{ text: string }>;
			};
			expect(result.content[0]?.text).toBe('posts: 5 rows.');
			expect(stderr).toContain('noise from the config');
			expect(stderr).toMatch(/drizzle-mcp \S+ is serving .* read-only\./);
		} finally {
			await client.close();
			await blog.cleanup();
		}
	});

	it('fails clearly without a config', async () => {
		const [command, args] = node([]);
		const error = await promisify(execFile)(command, [...args], { cwd: '/' }).catch(
			(e: { stderr: string; code: number }) => e,
		);
		expect(error).toMatchObject({ code: 1 });
		expect((error as { stderr: string }).stderr).toBe(
			'drizzle-mcp: No drizzle.config.ts in /. Pass --config with its path.\n',
		);
	});
});
