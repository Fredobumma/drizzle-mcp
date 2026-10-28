/**
 * Turns database values into something an agent can read: JSON-safe, with
 * long text cut short and secrets hidden, and tables as Markdown.
 */

import type { ColumnModel, EnumModel, SchemaModel, TableModel } from './model.js';

export interface FormatOptions {
	/** Columns whose names match are shown as `[redacted]`. `null` shows everything. */
	redact: RegExp | null;
	/** Strings longer than this are cut short. */
	maxText: number;
}

/** Names that usually hold credentials. */
export const DEFAULT_REDACT = /pass(word|wd|phrase)?|secret|token|api_?key|private_?key|credential|salt|hash|otp|totp/i;

function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… (${(text.length - max).toLocaleString('en')} more characters)`;
}

/** A JSON-safe copy of `value`, with long strings shortened. */
export function plain(value: unknown, options: FormatOptions): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') return cut(value, options.maxText);
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		return `<${value.byteLength.toLocaleString('en')} bytes>`;
	}
	if (Array.isArray(value)) return value.map((item) => plain(item, options));
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = plain(item, options);
		return out;
	}
	return value;
}

/** `true` if a column called `name` should be hidden. */
export function isSecret(name: string, options: FormatOptions): boolean {
	return options.redact?.test(name) ?? false;
}

/** Hides secret fields in rows returned by relational queries, nested relations included. */
export function redactRows(rows: unknown[], options: FormatOptions): unknown[] {
	const visit = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(visit);
		if (value === null || typeof value !== 'object' || value instanceof Date) return value;
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = item !== null && isSecret(key, options) && typeof item !== 'object' ? '[redacted]' : visit(item);
		}
		return out;
	};
	return rows.map(visit);
}

function cell(value: unknown): string {
	if (value === null) return '∅';
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.replaceAll('|', '\\|').replace(/\r?\n/g, '↵');
}

/** A Markdown table. */
export function markdownTable(columns: string[], rows: unknown[][]): string {
	if (columns.length === 0) return '';
	const header = `| ${columns.map(cell).join(' | ')} |`;
	const rule = `| ${columns.map(() => '---').join(' | ')} |`;
	return [header, rule, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

function columnLine(column: ColumnModel, table: TableModel): string {
	const notes: string[] = [];
	if (column.primaryKey || (table.primaryKey.length === 1 && table.primaryKey[0] === column.name))
		notes.push('primary key');
	if (column.unique) notes.push('unique');
	const reference = table.foreignKeys.find((key) => key.columns.length === 1 && key.columns[0] === column.name);
	if (reference) {
		const action = reference.onDelete ? `, on delete ${reference.onDelete}` : '';
		notes.push(`→ ${reference.table}.${reference.foreignColumns[0]}${action}`);
	}
	if (column.enumValues) notes.push(`one of ${column.enumValues.map((value) => `'${value}'`).join(', ')}`);
	const name = column.key === column.name ? column.key : `${column.key} (${column.name})`;
	return `| ${name} | ${column.type} | ${column.notNull ? 'no' : 'yes'} | ${cell(column.default ?? '')} | ${notes.join('; ')} |`;
}

/** A table in full: columns, keys, indexes, checks and relations. */
export function describeTable(table: TableModel): string {
	const qualified = table.schema ? `${table.schema}.${table.name}` : table.name;
	const lines = [
		`## ${table.key}`,
		'',
		`SQL table \`${qualified}\`${table.source ? `, exported as \`${table.key}\` from \`${table.source}\`` : ''}.`,
		'',
		'| column (TS key, SQL name) | type | nullable | default | notes |',
		'| --- | --- | --- | --- | --- |',
		...table.columns.map((column) => columnLine(column, table)),
	];
	if (table.primaryKey.length > 1) lines.push('', `Primary key: (${table.primaryKey.join(', ')})`);
	const multi = table.foreignKeys.filter((key) => key.columns.length > 1);
	for (const key of multi) {
		lines.push(
			`Foreign key ${key.name}: (${key.columns.join(', ')}) → ${key.table} (${key.foreignColumns.join(', ')})`,
		);
	}
	for (const unique of table.uniques) lines.push(`Unique ${unique.name}: (${unique.columns.join(', ')})`);
	if (table.indexes.length > 0) {
		lines.push(
			'',
			'Indexes:',
			...table.indexes.map(
				(index) =>
					`- ${index.name}: ${index.unique ? 'unique ' : ''}(${index.columns.join(', ')})${index.where ? ` where ${index.where}` : ''}`,
			),
		);
	}
	if (table.checks.length > 0) {
		lines.push('', 'Checks:', ...table.checks.map((check) => `- ${check.name}: ${check.expression}`));
	}
	if (table.relations.length > 0) {
		lines.push(
			'',
			'Relations (for `browse` with `with`, or `db.query` in code):',
			...table.relations.map((relation) => {
				const link = relation.fields.length
					? ` on ${table.key}.${relation.fields.join(', ')} = ${relation.table}.${relation.references.join(', ')}`
					: '';
				return `- ${relation.name}: ${relation.kind} ${relation.table}${link}`;
			}),
		);
	}
	return lines.join('\n');
}

function enumLine(item: EnumModel): string {
	const name = item.schema ? `${item.schema}.${item.name}` : item.name;
	return `- ${item.key} (\`${name}\`): ${item.values.map((value) => `'${value}'`).join(', ')}`;
}

/** Every table in a line or two, for a first look. */
export function describeSchema(model: SchemaModel): string {
	const lines = [`# Drizzle schema (${model.dialect})`, ''];
	if (model.tables.length === 0) lines.push('The schema has no tables.');
	lines.push('| table (TS export) | SQL name | columns | relations | file |', '| --- | --- | --- | --- | --- |');
	for (const table of model.tables) {
		const qualified = table.schema ? `${table.schema}.${table.name}` : table.name;
		const relations = table.relations.map((relation) => `${relation.name} → ${relation.table}`).join(', ');
		lines.push(
			`| ${table.key} | ${qualified} | ${table.columns.map((column) => column.key).join(', ')} | ${relations} | ${table.source ?? ''} |`,
		);
	}
	if (model.enums.length > 0) lines.push('', 'Enums:', ...model.enums.map(enumLine));
	lines.push('', 'Call `schema` with a table for its column types, keys, indexes and relations.');
	return lines.join('\n');
}
