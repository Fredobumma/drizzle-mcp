/**
 * The filter language `browse` and `count` accept, turned into Drizzle
 * conditions. Values are always bound as parameters, never spliced into SQL.
 */

import { z } from 'zod';
import { type ColumnModel, findColumn, type TableModel } from './model.js';

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const condition = z
	.object({
		eq: scalar,
		ne: scalar,
		gt: scalar,
		gte: scalar,
		lt: scalar,
		lte: scalar,
		like: z.string(),
		ilike: z.string(),
		in: z.array(scalar),
		notIn: z.array(scalar),
		isNull: z.boolean(),
	})
	.partial()
	.strict();

export type Condition = z.infer<typeof condition>;

export interface Filter {
	[column: string]: z.infer<typeof scalar> | Condition | Filter[] | undefined;
	or?: Filter[];
}

export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
	z
		.record(z.string(), z.union([scalar, condition, z.array(filterSchema)]))
		.describe(
			'Conditions that must all hold, keyed by column (TypeScript key or SQL name). A plain value means equals: ' +
				'{"published": true}. Operators: {"createdAt": {"gte": "2026-01-01"}}, {"title": {"ilike": "%drizzle%"}}, ' +
				'{"id": {"in": [1, 2]}}, {"deletedAt": {"isNull": true}}. Use {"or": [{...}, {...}]} for alternatives.',
		),
) as z.ZodType<Filter>;

/** The operators from the project's drizzle-orm. */
export interface Operators {
	and(...conditions: unknown[]): unknown;
	or(...conditions: unknown[]): unknown;
	eq(column: unknown, value: unknown): unknown;
	ne(column: unknown, value: unknown): unknown;
	gt(column: unknown, value: unknown): unknown;
	gte(column: unknown, value: unknown): unknown;
	lt(column: unknown, value: unknown): unknown;
	lte(column: unknown, value: unknown): unknown;
	like(column: unknown, value: unknown): unknown;
	ilike(column: unknown, value: unknown): unknown;
	inArray(column: unknown, values: unknown[]): unknown;
	notInArray(column: unknown, values: unknown[]): unknown;
	isNull(column: unknown): unknown;
	isNotNull(column: unknown): unknown;
}

/** Turns JSON values into what the column's Drizzle type expects, such as a `Date` for timestamps. */
function coerce(value: unknown, column: ColumnModel): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map((item) => coerce(item, column));
	if (column.dataType === 'date' && (typeof value === 'string' || typeof value === 'number')) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) throw new Error(`"${value}" isn't a date ${column.key} can compare with.`);
		return date;
	}
	if (column.dataType === 'bigint' && (typeof value === 'string' || typeof value === 'number')) return BigInt(value);
	return value;
}

/** Builds the condition for `filter` against `table`, whose Drizzle columns are `columns`. */
export function toCondition(
	filter: Filter | undefined,
	table: TableModel,
	columns: Record<string, unknown>,
	ops: Operators,
	dialect: 'postgresql' | 'sqlite',
): unknown {
	if (!filter) return undefined;
	const parts: unknown[] = [];
	for (const [name, rule] of Object.entries(filter)) {
		if (rule === undefined) continue;
		if (name === 'or') {
			if (!Array.isArray(rule)) throw new Error('`or` takes a list of filters.');
			const options = rule.map((option) => toCondition(option, table, columns, ops, dialect)).filter(Boolean);
			if (options.length > 0) parts.push(ops.or(...options));
			continue;
		}
		const model = findColumn(table, name);
		const column = columns[model.key];
		if (Array.isArray(rule)) throw new Error(`Give "${name}" a value or an operator object, not a list.`);
		if (rule === null) {
			parts.push(ops.isNull(column));
			continue;
		}
		if (typeof rule !== 'object') {
			parts.push(ops.eq(column, coerce(rule, model)));
			continue;
		}
		for (const [operator, raw] of Object.entries(rule as Condition)) {
			const value = operator === 'like' || operator === 'ilike' || operator === 'isNull' ? raw : coerce(raw, model);
			switch (operator) {
				case 'eq':
					parts.push(value === null ? ops.isNull(column) : ops.eq(column, value));
					break;
				case 'ne':
					parts.push(value === null ? ops.isNotNull(column) : ops.ne(column, value));
					break;
				case 'gt':
				case 'gte':
				case 'lt':
				case 'lte':
					parts.push(ops[operator](column, value));
					break;
				case 'like':
					parts.push(ops.like(column, value));
					break;
				case 'ilike':
					// SQLite's LIKE already ignores ASCII case.
					parts.push(dialect === 'sqlite' ? ops.like(column, value) : ops.ilike(column, value));
					break;
				case 'in':
					parts.push(ops.inArray(column, value as unknown[]));
					break;
				case 'notIn':
					parts.push(ops.notInArray(column, value as unknown[]));
					break;
				case 'isNull':
					parts.push(value ? ops.isNull(column) : ops.isNotNull(column));
					break;
			}
		}
	}
	if (parts.length === 0) return undefined;
	return parts.length === 1 ? parts[0] : ops.and(...parts);
}
