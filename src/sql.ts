/** Small SQL helpers that don't need a parser. */

/** Blanks out comments and quoted text, so semicolons and keywords inside them don't count. */
export function stripLiterals(sql: string): string {
	let out = '';
	let i = 0;
	while (i < sql.length) {
		const char = sql.charAt(i);
		const next = sql.charAt(i + 1);
		if (char === '-' && next === '-') {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? sql.length : end;
			continue;
		}
		if (char === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? sql.length : end + 2;
			out += ' ';
			continue;
		}
		if (char === "'" || char === '"' || char === '`') {
			// Postgres E'' strings escape with backslashes; everything else doubles the quote.
			const backslashes = char === "'" && /[eE]$/.test(out);
			let j = i + 1;
			for (; j < sql.length; j++) {
				if (backslashes && sql.charAt(j) === '\\') {
					j++;
					continue;
				}
				if (sql.charAt(j) === char) {
					if (sql.charAt(j + 1) === char) {
						j++;
						continue;
					}
					break;
				}
			}
			out += ' ';
			i = j + 1;
			continue;
		}
		if (char === '$') {
			const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))?.[0];
			if (tag) {
				const end = sql.indexOf(tag, i + tag.length);
				i = end === -1 ? sql.length : end + tag.length;
				out += ' ';
				continue;
			}
		}
		out += char;
		i++;
	}
	return out;
}

/**
 * Returns `sql` without a trailing semicolon, or throws if it holds more than
 * one statement. Drivers enforce this too; checking first gives a clearer
 * message and guards drivers that would run them all.
 */
export function singleStatement(sql: string): string {
	const trimmed = sql.replace(/(?:;|\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+$/, '').trim();
	const bare = stripLiterals(trimmed);
	if (!bare.trim()) throw new Error('The SQL is empty.');
	if (bare.includes(';')) throw new Error('Send one statement at a time; this SQL has several.');
	return trimmed;
}

/** The statement's first keyword in lower case, such as `select` or `with`. */
export function firstKeyword(sql: string): string {
	return /^[\s(]*([A-Za-z]+)/.exec(stripLiterals(sql))?.[1]?.toLowerCase() ?? '';
}

/** Statements that only return rows, which can run behind a cursor or a LIMIT. */
export function isQuery(sql: string): boolean {
	return ['select', 'with', 'values', 'table'].includes(firstKeyword(sql));
}

/** A double-quoted identifier. */
export function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}
