import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	schema: './schema.ts',
	out: './drizzle',
	dbCredentials: { url: process.env.BLOG_SQLITE_FILE ?? './blog.db' },
});
