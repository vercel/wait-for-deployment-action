import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '../src/core.ts';

const originalEnv = { ...process.env };

describe('getInput', () => {
	beforeEach(() => {
		for (const k of Object.keys(process.env)) {
			if (k.startsWith('INPUT_')) delete process.env[k];
		}
	});
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('reads from INPUT_<UPPERCASED_NAME>', () => {
		process.env.INPUT_FOO = 'bar';
		expect(core.getInput('foo')).toBe('bar');
	});

	it('preserves dashes in input names', () => {
		// Bracket access is required because the env var name has a `-` in it.
		process.env['INPUT_GITHUB-TOKEN'] = 'ghs_test';
		expect(core.getInput('github-token')).toBe('ghs_test');
	});

	it('replaces spaces with underscores', () => {
		process.env.INPUT_MY_INPUT = 'value';
		expect(core.getInput('my input')).toBe('value');
	});

	it('trims whitespace by default', () => {
		process.env.INPUT_FOO = '  bar  ';
		expect(core.getInput('foo')).toBe('bar');
	});

	it('preserves whitespace when trimWhitespace=false', () => {
		process.env.INPUT_FOO = '  bar  ';
		expect(core.getInput('foo', { trimWhitespace: false })).toBe('  bar  ');
	});

	it('returns empty string when unset', () => {
		expect(core.getInput('nope')).toBe('');
	});
});

describe('setOutput', () => {
	let tmpFile: string;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpFile = path.join(
			os.tmpdir(),
			`gh_output_${Date.now()}_${Math.random()}`,
		);
		fs.writeFileSync(tmpFile, '');
		stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(() => true);
	});
	afterEach(() => {
		try {
			fs.unlinkSync(tmpFile);
		} catch {}
		delete process.env.GITHUB_OUTPUT;
		stdoutSpy.mockRestore();
	});

	it('writes a heredoc-style entry to GITHUB_OUTPUT when set', () => {
		process.env.GITHUB_OUTPUT = tmpFile;
		core.setOutput('deployment-url', 'https://example.com');
		const written = fs.readFileSync(tmpFile, 'utf8');
		expect(written).toMatch(
			/^deployment-url<<ghadelimiter_[0-9a-f]{16}\nhttps:\/\/example\.com\nghadelimiter_[0-9a-f]{16}\n$/,
		);
		// The opening and closing delimiters must match.
		const m = written.match(/<<(\S+)\n[\s\S]*?\n(\S+)\n$/);
		expect(m).not.toBeNull();
		expect(m?.[1]).toBe(m?.[2]);
	});

	it('falls back to ::set-output:: when GITHUB_OUTPUT is unset', () => {
		delete process.env.GITHUB_OUTPUT;
		core.setOutput('k', 'v');
		expect(stdoutSpy).toHaveBeenCalledWith(
			expect.stringContaining('::set-output name=k::v'),
		);
	});

	it('throws if the value somehow contains the delimiter', () => {
		// This is essentially impossible by chance, so we mock crypto to
		// force a collision.
		const original = globalThis.crypto.getRandomValues;
		const fixed = new Uint8Array(8).fill(0xaa);
		const spy = vi
			.spyOn(globalThis.crypto, 'getRandomValues')
			.mockImplementation((arr) => {
				if (arr instanceof Uint8Array) arr.set(fixed);
				return arr;
			});
		process.env.GITHUB_OUTPUT = tmpFile;
		try {
			expect(() =>
				core.setOutput('k', 'before ghadelimiter_aaaaaaaaaaaaaaaa after'),
			).toThrow(/cannot contain the random delimiter/);
		} finally {
			spy.mockRestore();
			globalThis.crypto.getRandomValues = original;
		}
	});
});

describe('info / warning / setFailed', () => {
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let exitCodeBefore: typeof process.exitCode;

	beforeEach(() => {
		stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(() => true);
		exitCodeBefore = process.exitCode;
	});
	afterEach(() => {
		stdoutSpy.mockRestore();
		process.exitCode = exitCodeBefore;
	});

	it('info() writes a plain line', () => {
		core.info('hello world');
		expect(stdoutSpy).toHaveBeenCalledWith(
			expect.stringMatching(/^hello world(\r?\n|\n)$/),
		);
	});

	it('warning() emits a ::warning:: annotation with escaped data', () => {
		core.warning('something\nbad: 50%');
		expect(stdoutSpy).toHaveBeenCalledWith(
			expect.stringContaining('::warning::something%0Abad: 50%25'),
		);
	});

	it('setFailed() emits ::error:: and sets process.exitCode', () => {
		core.setFailed('boom');
		expect(process.exitCode).toBe(1);
		expect(stdoutSpy).toHaveBeenCalledWith(
			expect.stringContaining('::error::boom'),
		);
	});
});
