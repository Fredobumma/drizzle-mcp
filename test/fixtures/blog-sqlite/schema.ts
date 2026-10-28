import { relations, sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	email: text('email').notNull().unique(),
	displayName: text('display_name').notNull(),
	role: text('role', { enum: ['reader', 'author', 'admin'] })
		.notNull()
		.default('reader'),
	passwordHash: text('password_hash').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const posts = sqliteTable(
	'posts',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		authorId: integer('author_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		body: text('body').notNull(),
		published: integer('published', { mode: 'boolean' }).notNull().default(false),
		rating: real('rating'),
		metadata: text('metadata', { mode: 'json' }).$type<{ tags: string[] }>(),
	},
	(table) => [index('posts_author_idx').on(table.authorId)],
);

export const comments = sqliteTable('comments', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	postId: integer('post_id')
		.notNull()
		.references(() => posts.id, { onDelete: 'cascade' }),
	authorId: integer('author_id').references(() => users.id),
	body: text('body').notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts), comments: many(comments) }));

export const postsRelations = relations(posts, ({ one, many }) => ({
	author: one(users, { fields: [posts.authorId], references: [users.id] }),
	comments: many(comments),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
	post: one(posts, { fields: [comments.postId], references: [posts.id] }),
	author: one(users, { fields: [comments.authorId], references: [users.id] }),
}));
