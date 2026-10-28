import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/server.js';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const server = read('server.json');

// A release changes these by hand in four places; they have to agree.
describe('release metadata', () => {
	it('reports the version npm publishes', () => {
		expect(VERSION).toBe(pkg.version);
	});

	it('lists the same server and version in the MCP Registry', () => {
		// The registry checks that the npm package's mcpName is exactly the server's name,
		// and the name must start with the GitHub login, case included.
		expect(server.name).toBe(pkg.mcpName);
		expect(server.name).toMatch(/^io\.github\.Fredobumma\//);
		expect(server.version).toBe(pkg.version);
		expect(server.packages).toEqual([
			{ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } },
		]);
	});
});
