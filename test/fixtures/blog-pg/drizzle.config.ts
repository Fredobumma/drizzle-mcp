import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'postgresql',
	driver: 'pglite',
	schema: './schema.ts',
	out: './drizzle',
	dbCredentials: { url: process.env.BLOG_PG_DIR ?? './.pglite' },
});

// Lets the stdio test check that output like this can't reach the protocol stream.
if (process.env.BLOG_NOISY) console.log('noise from the config');
