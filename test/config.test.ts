import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	composeEnvironmentName,
	composeStatusContext,
	resolveConfig,
} from '../src/config.ts';

const originalEnv = { ...process.env };

function setInputs(inputs: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(inputs)) {
		// @actions/core only replaces spaces with `_`; dashes stay as-is.
		const envName = `INPUT_${k.toUpperCase().replace(/ /g, '_')}`;
		if (v === undefined) delete process.env[envName];
		else process.env[envName] = v;
	}
}

describe('composeEnvironmentName', () => {
	it('returns the bare environment when no slug is provided', () => {
		expect(composeEnvironmentName('preview', '')).toBe('Preview');
		expect(composeEnvironmentName('production', '')).toBe('Production');
	});

	it('suffixes the slug when provided', () => {
		expect(composeEnvironmentName('preview', 'my-app')).toBe(
			'Preview – my-app',
		);
		expect(composeEnvironmentName('production', 'my-app')).toBe(
			'Production – my-app',
		);
	});
});

describe('composeStatusContext', () => {
	it('returns the bare context when no slug is provided', () => {
		expect(composeStatusContext('')).toBe('Vercel');
	});

	it('suffixes the slug when provided', () => {
		expect(composeStatusContext('my-app')).toBe('Vercel – my-app');
	});
});

describe('resolveConfig', () => {
	beforeEach(() => {
		// Wipe all INPUT_* and GH-managed env vars to a known baseline.
		for (const key of Object.keys(process.env)) {
			if (key.startsWith('INPUT_')) delete process.env[key];
		}
		process.env.GITHUB_REPOSITORY = 'octocat/hello';
		process.env.GITHUB_SHA = '1111111111111111111111111111111111111111';
		delete process.env.GITHUB_EVENT_NAME;
		delete process.env.GITHUB_EVENT_PATH;
		setInputs({ 'github-token': 'ghs_test' });
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('defaults to bare Preview / Vercel for single-project repos', () => {
		const cfg = resolveConfig();
		expect(cfg.environmentName).toBe('Preview');
		expect(cfg.statusContext).toBe('Vercel');
		expect(cfg.requireDeploymentId).toBe(true);
		expect(cfg.timeout).toBe(600);
		expect(cfg.checkInterval).toBe(10);
		expect(cfg.owner).toBe('octocat');
		expect(cfg.repo).toBe('hello');
		expect(cfg.sha).toBe('1111111111111111111111111111111111111111');
	});

	it('suffixes with project-slug', () => {
		setInputs({ 'project-slug': 'my-app' });
		const cfg = resolveConfig();
		expect(cfg.environmentName).toBe('Preview – my-app');
		expect(cfg.statusContext).toBe('Vercel – my-app');
	});

	it('respects environment-name override', () => {
		setInputs({
			'project-slug': 'my-app',
			'environment-name': 'My Custom Env',
		});
		const cfg = resolveConfig();
		expect(cfg.environmentName).toBe('My Custom Env');
		// status-context still auto-composes from project-slug
		expect(cfg.statusContext).toBe('Vercel – my-app');
	});

	it('respects status-context override', () => {
		setInputs({ 'status-context': 'My Status' });
		const cfg = resolveConfig();
		expect(cfg.statusContext).toBe('My Status');
	});

	it('treats explicit empty status-context as opt-out', () => {
		setInputs({ 'status-context': '' });
		const cfg = resolveConfig();
		expect(cfg.statusContext).toBe('');
	});

	it('uses production env name', () => {
		setInputs({ environment: 'production' });
		expect(resolveConfig().environmentName).toBe('Production');
	});

	it('rejects unknown environment values', () => {
		setInputs({ environment: 'staging' });
		expect(() => resolveConfig()).toThrow(/must be "production" or "preview"/);
	});

	it('parses require-deployment-id as bool', () => {
		setInputs({ 'require-deployment-id': 'false' });
		expect(resolveConfig().requireDeploymentId).toBe(false);
	});

	it('rejects non-boolean require-deployment-id', () => {
		setInputs({ 'require-deployment-id': 'maybe' });
		expect(() => resolveConfig()).toThrow(/expected a boolean/);
	});

	it('parses positive int inputs', () => {
		setInputs({ timeout: '120', 'check-interval': '5' });
		const cfg = resolveConfig();
		expect(cfg.timeout).toBe(120);
		expect(cfg.checkInterval).toBe(5);
	});

	it('falls back when timeout / check-interval are non-numeric or non-positive', () => {
		setInputs({ timeout: 'abc', 'check-interval': '-3' });
		const cfg = resolveConfig();
		expect(cfg.timeout).toBe(600);
		expect(cfg.checkInterval).toBe(10);
	});

	it('uses explicit sha input when provided', () => {
		setInputs({ sha: '2222222222222222222222222222222222222222' });
		expect(resolveConfig().sha).toBe(
			'2222222222222222222222222222222222222222',
		);
	});

	it('requires a token', () => {
		setInputs({ 'github-token': '' });
		delete process.env.GITHUB_TOKEN;
		expect(() => resolveConfig()).toThrow(/github-token/);
	});
});
