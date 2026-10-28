import { describe, expect, it } from 'vitest';
import { firstKeyword, isQuery, singleStatement, stripLiterals } from '../../src/sql.js';

describe('singleStatement', () => {
	it('accepts one statement, with or without a trailing semicolon or comment', () => {
		expect(singleStatement('select 1')).toBe('select 1');
		expect(singleStatement('  select 1;  ')).toBe('select 1');
		expect(singleStatement('select 1; -- the end\n')).toBe('select 1');
		expect(singleStatement('select 1; /* bye */')).toBe('select 1');
	});

	it('ignores semicolons in strings, identifiers, comments and dollar quotes', () => {
		for (const sql of [
			"select 'a;b'",
			'select "odd;name" from t',
			'select 1 -- not; here',
			'select /* ; */ 1',
			'select $$a;b$$, $tag$c;d$tag$',
			"select 'it''s; fine'",
			"select E'it\\'s; fine'",
		]) {
			expect(() => singleStatement(sql), sql).not.toThrow();
		}
	});

	it('refuses several statements', () => {
		for (const sql of [
			'select 1; select 2',
			"select 'x'; drop table t",
			'select 1; commit; drop table t',
			'select $$;$$; delete from t',
		]) {
			expect(() => singleStatement(sql), sql).toThrow('Send one statement at a time');
		}
	});

	it('refuses empty SQL', () => {
		expect(() => singleStatement(' ; -- nothing')).toThrow('The SQL is empty.');
	});
});

describe('keywords', () => {
	it('finds the first keyword past comments and parentheses', () => {
		expect(firstKeyword('-- hi\n (SELECT 1)')).toBe('select');
		expect(firstKeyword('/* x */ with a as (select 1) select * from a')).toBe('with');
		expect(stripLiterals("select 'drop table'")).toBe('select  ');
	});

	it('knows which statements only return rows', () => {
		expect(isQuery('select 1')).toBe(true);
		expect(isQuery('values (1)')).toBe(true);
		expect(isQuery('explain select 1')).toBe(false);
		expect(isQuery('insert into t values (1)')).toBe(false);
	});
});
