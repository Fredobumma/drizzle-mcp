import { relations, sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	primaryKey,
	serial,
	text,
	timestamp,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

export const role = pgEnum('role', ['reader', 'author', 'admin']);

export const users = pgTable('users', {
	id: serial('id').primaryKey(),
	email: varchar('email', { length: 255 }).notNull().unique(),
	displayName: text('display_name').notNull(),
	role: role('role').notNull().default('reader'),
	passwordHash: text('password_hash').notNull(),
	apiToken: uuid('api_token').defaultRandom(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const posts = pgTable(
	'posts',
	{
		id: serial('id').primaryKey(),
		authorId: integer('author_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		body: text('body').notNull(),
		published: boolean('published').notNull().default(false),
		rating: numeric('rating', { precision: 3, scale: 1 }),
		metadata: jsonb('metadata').$type<{ tags: string[] }>(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index('posts_author_idx').on(table.authorId),
		check('posts_rating_range', sql`${table.rating} between 0 and 5`),
	],
);

export const tags = pgTable('tags', {
	id: serial('id').primaryKey(),
	name: text('name').notNull().unique(),
});

export const postTags = pgTable(
	'post_tags',
	{
		postId: integer('post_id')
			.notNull()
			.references(() => posts.id, { onDelete: 'cascade' }),
		tagId: integer('tag_id')
			.notNull()
			.references(() => tags.id, { onDelete: 'cascade' }),
	},
	(table) => [primaryKey({ columns: [table.postId, table.tagId] })],
);

export const comments = pgTable('comments', {
	id: serial('id').primaryKey(),
	postId: integer('post_id')
		.notNull()
		.references(() => posts.id, { onDelete: 'cascade' }),
	authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
	body: text('body').notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
	posts: many(posts),
	comments: many(comments),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
	author: one(users, { fields: [posts.authorId], references: [users.id] }),
	comments: many(comments),
	postTags: many(postTags),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
	postTags: many(postTags),
}));

export const postTagsRelations = relations(postTags, ({ one }) => ({
	post: one(posts, { fields: [postTags.postId], references: [posts.id] }),
	tag: one(tags, { fields: [postTags.tagId], references: [tags.id] }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
	post: one(posts, { fields: [comments.postId], references: [posts.id] }),
	author: one(users, { fields: [comments.authorId], references: [users.id] }),
}));
