/**
 * A throwaway copy of a fixture project. It lives inside the repository so
 * the copy's imports of drizzle-orm still resolve.
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function copyFixture(fixture: string) {
	const dir = join(root, 'test', '.tmp', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await mkdir(dir, { recursive: true });
	await cp(fixture, dir, { recursive: true, filter: (path) => !/\.pglite|\.db$|drizzle$/.test(path) });
	return {
		dir,
		config: join(dir, 'drizzle.config.ts'),
		/** Rewrites the schema with `edit` and moves its timestamp forward, as an editor would. */
		async editSchema(edit: (source: string) => string) {
			const file = join(dir, 'schema.ts');
			await writeFile(file, edit(await readFile(file, 'utf8')));
			const later = new Date(Date.now() + 2000);
			await utimes(file, later, later);
		},
		/** Runs drizzle-kit, as a developer would. */
		async drizzleKit(...args: string[]) {
			await promisify(execFile)(
				join(root, 'node_modules', '.bin', 'drizzle-kit'),
				[...args, '--config', join(dir, 'drizzle.config.ts')],
				{
					cwd: dir,
				},
			);
		},
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}
