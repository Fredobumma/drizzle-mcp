#!/usr/bin/env node
/**
 * `drizzle-mcp`: runs the server over stdio for Claude Code, Cursor and
 * other MCP clients.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

// stdout carries the protocol. Anything else that writes to it (a dotenv
// banner, a console.log in a schema file) goes to stderr instead.
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
const protocol = new Writable({
	write(chunk, encoding, callback) {
		protocolWrite(chunk, encoding, callback);
	},
});

const HELP = `Usage: drizzle-mcp [options]

Runs an MCP server that lets agents explore your database through your Drizzle
schema. Start it from the folder with drizzle.config.ts, or pass --config.

Options:
  --config <path>     The Drizzle config (default: drizzle.config.ts in this folder)
  --url <url>         Connect here instead of the config's dbCredentials
  --driver <name>     pg, postgres, pglite, better-sqlite3 or libsql (default: the one installed)
  --allow-writes      Add the execute tool and allow changing data (default: read-only)
  --max-rows <n>      The most rows a tool returns (default: 100)
  --timeout <ms>      Statement time limit (default: 15000)
  --max-text <n>      Cut strings longer than this (default: 500)
  --redact <regex>    Hide columns whose names match (default: password, secret, token…)
  --show-secrets      Don't hide any columns
  -h, --help          Show this help
  -v, --version       Show the version
`;

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			config: { type: 'string' },
			url: { type: 'string' },
			driver: { type: 'string' },
			'allow-writes': { type: 'boolean' },
			'max-rows': { type: 'string' },
			timeout: { type: 'string' },
			'max-text': { type: 'string' },
			redact: { type: 'string' },
			'show-secrets': { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
			version: { type: 'boolean', short: 'v' },
		},
	});

	const { createServer, VERSION } = await import('./server.js');
	if (values.help) {
		process.stderr.write(HELP);
		return;
	}
	if (values.version) {
		process.stderr.write(`${VERSION}\n`);
		return;
	}

	const { findConfig } = await import('./project.js');
	const config = values.config ? resolve(values.config) : findConfig(process.cwd());
	if (!existsSync(config)) throw new Error(`No Drizzle config at ${config}.`);
	// Run from the project, as drizzle-kit does, so its .env and relative paths resolve the same way.
	process.chdir(dirname(config));

	const number = (value: string | undefined, name: string) => {
		if (value === undefined) return undefined;
		const parsed = Number(value);
		if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} needs a positive whole number.`);
		return parsed;
	};
	const drivers = ['pg', 'postgres', 'pglite', 'better-sqlite3', 'libsql'] as const;
	if (values.driver && !drivers.includes(values.driver as (typeof drivers)[number])) {
		throw new Error(`--driver must be one of ${drivers.join(', ')}.`);
	}

	const { server, close } = await createServer({
		config,
		url: values.url,
		driver: values.driver as (typeof drivers)[number] | undefined,
		allowWrites: values['allow-writes'] ?? false,
		maxRows: number(values['max-rows'], 'max-rows'),
		timeout: number(values.timeout, 'timeout'),
		maxText: number(values['max-text'], 'max-text'),
		redact: values['show-secrets'] ? null : values.redact ? new RegExp(values.redact, 'i') : undefined,
	});

	const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
	let closing = false;
	const shutdown = async () => {
		if (closing) return;
		closing = true;
		await close().catch(() => {});
		process.exit(0);
	};
	server.server.onclose = shutdown;
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	await server.connect(new StdioServerTransport(process.stdin, protocol));
	process.stderr.write(
		`drizzle-mcp ${VERSION} is serving ${config}${values['allow-writes'] ? ' with writes allowed' : ' read-only'}.\n`,
	);
}

main().catch((error: unknown) => {
	process.stderr.write(`drizzle-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
