import { describe, expect, it } from 'vitest';
import { normalizePgType } from '../../src/drift.js';
import { DEFAULT_REDACT, markdownTable, plain, redactRows } from '../../src/format.js';

const options = { redact: DEFAULT_REDACT, maxText: 10 };

describe('plain', () => {
	it('makes values JSON-safe and short', () => {
		expect(
			plain(
				{
					when: new Date(Date.UTC(2026, 0, 2)),
					big: 2n ** 70n,
					bytes: new Uint8Array(2048),
					text: 'abcdefghijklmnop',
					nested: [{ text: 'x'.repeat(12) }],
				},
				options,
			),
		).toEqual({
			when: '2026-01-02T00:00:00.000Z',
			big: '1180591620717411303424',
			bytes: '<2,048 bytes>',
			text: 'abcdefghij… (6 more characters)',
			nested: [{ text: 'xxxxxxxxxx… (2 more characters)' }],
		});
	});
});

describe('redaction', () => {
	it('hides secret-looking fields, nested ones included, but not their null values or objects', () => {
		expect(
			redactRows(
				[{ id: 1, passwordHash: 'x', apiToken: null, author: { resetToken: 'y', name: 'Ada' }, tokens: [{ a: 1 }] }],
				options,
			),
		).toEqual([
			{
				id: 1,
				passwordHash: '[redacted]',
				apiToken: null,
				author: { resetToken: '[redacted]', name: 'Ada' },
				tokens: [{ a: 1 }],
			},
		]);
	});

	it('shows everything when redaction is off', () => {
		expect(redactRows([{ password: 'x' }], { redact: null, maxText: 10 })).toEqual([{ password: 'x' }]);
	});
});

describe('markdownTable', () => {
	it('escapes pipes and newlines and marks nulls', () => {
		expect(
			markdownTable(
				['a', 'b'],
				[
					['x|y', null],
					['line\nbreak', { k: 1 }],
				],
			),
		).toBe('| a | b |\n| --- | --- |\n| x\\|y | ∅ |\n| line↵break | {"k":1} |');
	});
});

describe('normalizePgType', () => {
	it.each([
		['serial', 'integer'],
		['bigserial', 'bigint'],
		['varchar(255)', 'character varying(255)'],
		['char', 'character(1)'],
		['numeric(3, 1)', 'numeric(3,1)'],
		['timestamp', 'timestamp without time zone'],
		['timestamp(3)', 'timestamp(3) without time zone'],
		['timestamp with time zone', 'timestamp with time zone'],
		['time', 'time without time zone'],
		['text[]', 'text[]'],
		['varchar(20)[]', 'character varying(20)[]'],
		['"role"', 'role'],
	])('%s → %s', (drizzle, postgres) => {
		expect(normalizePgType(drizzle)).toBe(postgres);
	});
});
