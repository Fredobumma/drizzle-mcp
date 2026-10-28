/**
 * Loads a Drizzle project the way drizzle-kit does: its config, its `.env`,
 * and every schema file the config points to. Modules are imported from the
 * project itself, so the server uses the project's own drizzle-orm and
 * database driver.
 */

import { existsSync } from 'node:fs';
import { glob, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createJiti } from 'jiti';

export type Dialect = 'postgresql' | 'sqlite' | 'turso' | 'mysql' | 'singlestore' | 'gel';

/** The parts of `drizzle.config.ts` the server reads. */
export interface DrizzleConfig {
	dialect: Dialect;
	driver?: string;
	schema?: string | string[];
	out?: string;
	dbCredentials?: Record<string, unknown>;
	casing?: 'snake_case' | 'camelCase';
	migrations?: { table?: string; schema?: string };
	schemaFilter?: string | string[];
	tablesFilter?: string | string[];
}

export interface Project {
	/** The folder holding the config, which relative paths in it are resolved against. */
	root: string;
	configPath: string;
	config: DrizzleConfig;
	/** Every export of every schema file, merged, as drizzle-kit and relational queries expect. */
	exports: Record<string, unknown>;
	/** The schema file each export came from, relative to `root`. */
	sources: Map<string, string>;
	/** The config and schema files, to notice when they change. */
	files: string[];
	/** Imports a module as the project would, such as its `drizzle-orm` or `pg`. */
	import<T = Record<string, unknown>>(specifier: string): Promise<T>;
	/** `true` if the project can import `specifier`. */
	has(specifier: string): boolean;
}

const CONFIG_FILES = [
	'drizzle.config.ts',
	'drizzle.config.mts',
	'drizzle.config.cts',
	'drizzle.config.js',
	'drizzle.config.mjs',
	'drizzle.config.cjs',
	'drizzle.config.json',
];

const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;

export function findConfig(cwd: string): string {
	for (const name of CONFIG_FILES) {
		const path = join(cwd, name);
		if (existsSync(path)) return path;
	}
	throw new Error(`No drizzle.config.ts in ${cwd}. Pass --config with its path.`);
}

/** `schema` can be a file, a folder or a glob, or a list of them. */
async function schemaFiles(root: string, schema: string | string[] | undefined): Promise<string[]> {
	if (!schema) throw new Error('The Drizzle config has no `schema`, so there are no tables to read.');
	const files = new Set<string>();
	for (const entry of Array.isArray(schema) ? schema : [schema]) {
		const path = resolve(root, entry);
		const info = await stat(path).catch(() => null);
		if (info?.isFile()) {
			files.add(path);
			continue;
		}
		const pattern = info?.isDirectory() ? join(relative(root, path), '**/*') : entry;
		for await (const match of glob(pattern, { cwd: root })) {
			const file = resolve(root, match);
			if (SOURCE_FILE.test(file) && !file.endsWith('.d.ts')) files.add(file);
		}
	}
	if (files.size === 0) throw new Error(`The schema path ${JSON.stringify(schema)} matches no files in ${root}.`);
	return [...files].sort();
}

function loadEnv(root: string): void {
	for (const name of ['.env', '.env.local']) {
		const path = join(root, name);
		if (!existsSync(path)) continue;
		try {
			process.loadEnvFile(path);
		} catch {
			// A malformed .env is the project's business; the config may not need it.
		}
	}
}

export interface LoadOptions {
	/** Path to the Drizzle config. Defaults to the one in `cwd`. */
	config?: string;
	cwd?: string;
}

export async function loadProject(options: LoadOptions = {}): Promise<Project> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const configPath = options.config ? resolve(cwd, options.config) : findConfig(cwd);
	if (!existsSync(configPath)) throw new Error(`No Drizzle config at ${configPath}.`);
	const root = dirname(configPath);
	loadEnv(root);

	// No module cache, so loading the project again picks up edits to its schema.
	const jiti = createJiti(configPath, { interopDefault: true, moduleCache: false, fsCache: false });
	const imports = new Map<string, Promise<unknown>>();
	const loaded = await jiti.import<DrizzleConfig | { default: DrizzleConfig }>(configPath, { default: true });
	const config = ('default' in loaded ? loaded.default : loaded) as DrizzleConfig;
	if (!config?.dialect) throw new Error(`${relative(cwd, configPath)} doesn't set a \`dialect\`.`);

	const exports: Record<string, unknown> = {};
	const sources = new Map<string, string>();
	const files = await schemaFiles(root, config.schema);
	for (const file of files) {
		const module = await jiti.import<Record<string, unknown>>(file);
		for (const [name, value] of Object.entries(module)) {
			if (name === 'default' || name === '__esModule') continue;
			exports[name] = value;
			sources.set(name, relative(root, file));
		}
	}

	return {
		root,
		configPath,
		config,
		exports,
		sources,
		files: [configPath, ...files],
		import<T>(specifier: string) {
			let module = imports.get(specifier);
			if (!module) {
				module = jiti.import<T>(specifier);
				imports.set(specifier, module);
			}
			return module as Promise<T>;
		},
		has(specifier: string) {
			try {
				jiti.esmResolve(specifier);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** A path from the config, resolved against the project instead of the server's working directory. */
export function projectPath(project: Project, path: string): string {
	return isAbsolute(path) ? path : resolve(project.root, path);
}
