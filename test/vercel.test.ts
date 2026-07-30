import { describe, expect, it } from 'vitest';
import {
	assertEnvironmentMatches,
	describeTarget,
	EnvironmentMismatchError,
	getDeploymentByHost,
	hostFromDeploymentUrl,
	type VercelDeployment,
} from '../src/vercel.ts';

function makeFetch(
	handler: (url: URL, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
	return ((url: URL, init?: RequestInit) =>
		Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
	return makeFetch(
		() =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' },
			}),
	);
}

describe('hostFromDeploymentUrl', () => {
	it('extracts the hostname', () => {
		expect(hostFromDeploymentUrl('https://my-app-a1b2c3.vercel.app')).toBe(
			'my-app-a1b2c3.vercel.app',
		);
	});

	it('drops path and port', () => {
		expect(
			hostFromDeploymentUrl('https://my-app.vercel.app:443/api/health'),
		).toBe('my-app.vercel.app');
	});

	it('throws on an unparseable URL', () => {
		expect(() => hostFromDeploymentUrl('not a url')).toThrow(
			/Could not parse a hostname/,
		);
	});
});

describe('getDeploymentByHost', () => {
	it('looks the deployment up by host and scopes it to the team', async () => {
		let captured: URL | undefined;
		let headers: Record<string, string> | undefined;
		const fetchImpl = makeFetch((url, init) => {
			captured = url;
			headers = init?.headers as Record<string, string>;
			return new Response(
				JSON.stringify({
					id: 'dpl_prod',
					url: 'my-app-a1b2c3.vercel.app',
					target: 'production',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		});

		const deployment = await getDeploymentByHost('my-app-a1b2c3.vercel.app', {
			token: 'vercel_test',
			teamId: 'team_test',
			fetchImpl,
		});

		expect(deployment).toEqual({
			id: 'dpl_prod',
			url: 'my-app-a1b2c3.vercel.app',
			target: 'production',
		});
		expect(captured?.toString()).toBe(
			'https://api.vercel.com/v13/deployments/my-app-a1b2c3.vercel.app?teamId=team_test',
		);
		expect(headers).toMatchObject({ Authorization: 'Bearer vercel_test' });
	});

	it('omits teamId when none is configured', async () => {
		let captured: URL | undefined;
		const fetchImpl = makeFetch((url) => {
			captured = url;
			return new Response(JSON.stringify({ id: 'dpl_x', target: null }), {
				status: 200,
			});
		});
		await getDeploymentByHost('my-app.vercel.app', {
			token: 't',
			teamId: '',
			fetchImpl,
		});
		expect(captured?.searchParams.has('teamId')).toBe(false);
	});

	it('normalizes a missing target to null (a preview deployment)', async () => {
		const deployment = await getDeploymentByHost('my-app.vercel.app', {
			token: 't',
			teamId: '',
			fetchImpl: jsonFetch({ id: 'dpl_preview' }),
		});
		expect(deployment.target).toBeNull();
	});

	it('points at vercel-team-id when a team-owned deployment 404s', async () => {
		await expect(
			getDeploymentByHost('my-app.vercel.app', {
				token: 't',
				teamId: '',
				fetchImpl: jsonFetch({ error: { code: 'not_found' } }, 404),
			}),
		).rejects.toThrow(/set the `vercel-team-id` input/);
	});

	it('mentions the configured team when a scoped lookup still 404s', async () => {
		await expect(
			getDeploymentByHost('my-app.vercel.app', {
				token: 't',
				teamId: 'team_abc',
				fetchImpl: jsonFetch({ error: { code: 'not_found' } }, 404),
			}),
		).rejects.toThrow(/`vercel-team-id` \("team_abc"\)/);
	});

	it('calls out the token on 401 / 403', async () => {
		for (const status of [401, 403]) {
			await expect(
				getDeploymentByHost('my-app.vercel.app', {
					token: 't',
					teamId: '',
					fetchImpl: jsonFetch({ error: { code: 'forbidden' } }, status),
				}),
			).rejects.toThrow(/`vercel-token` is invalid, expired, or lacks access/);
		}
	});

	it('rejects a body whose id is not a deployment ID', async () => {
		await expect(
			getDeploymentByHost('my-app.vercel.app', {
				token: 't',
				teamId: '',
				fetchImpl: jsonFetch({ id: 'not-a-deployment-id', target: null }),
			}),
		).rejects.toThrow(/unexpected deployment ID/);
	});

	it('never puts the token in the error message', async () => {
		const error = await getDeploymentByHost('my-app.vercel.app', {
			token: 'vercel_super_secret',
			teamId: '',
			fetchImpl: jsonFetch({ error: {} }, 500),
		}).then(
			() => null,
			(err: Error) => err,
		);
		expect(error?.message).not.toContain('vercel_super_secret');
		expect(error).not.toBeNull();
	});
});

describe('assertEnvironmentMatches', () => {
	const deployment = (target: string | null): VercelDeployment => ({
		id: 'dpl_test',
		target,
	});

	it('accepts a production target for the production environment', () => {
		expect(() =>
			assertEnvironmentMatches(
				deployment('production'),
				'production',
				'host.vercel.app',
			),
		).not.toThrow();
	});

	it('accepts a null target for the preview environment', () => {
		expect(() =>
			assertEnvironmentMatches(deployment(null), 'preview', 'host.vercel.app'),
		).not.toThrow();
	});

	it('accepts staging and custom environments as preview-like', () => {
		for (const target of ['staging', 'my-custom-env']) {
			expect(() =>
				assertEnvironmentMatches(
					deployment(target),
					'preview',
					'host.vercel.app',
				),
			).not.toThrow();
		}
	});

	// The incident this guard exists for: waiting on production, but the
	// resolved deployment is the preview build of the same commit.
	it('rejects a preview deployment when production was requested', () => {
		expect(() =>
			assertEnvironmentMatches(
				deployment(null),
				'production',
				'host.vercel.app',
			),
		).toThrow(EnvironmentMismatchError);
		expect(() =>
			assertEnvironmentMatches(
				deployment(null),
				'production',
				'host.vercel.app',
			),
		).toThrow(/waited for the "production" deployment.*dpl_test.*preview/s);
	});

	it('rejects a production deployment when preview was requested', () => {
		expect(() =>
			assertEnvironmentMatches(
				deployment('production'),
				'preview',
				'host.vercel.app',
			),
		).toThrow(EnvironmentMismatchError);
	});
});

describe('describeTarget', () => {
	it('renders null as preview and passes other values through', () => {
		expect(describeTarget(null)).toBe('preview');
		expect(describeTarget('production')).toBe('production');
		expect(describeTarget('staging')).toBe('staging');
	});
});
