import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '../src/core.ts';
import { GitHubClient } from '../src/github.ts';
import { run } from '../src/run.ts';

const originalEnv = { ...process.env };

/** The commit from the incident, deployed to production and preview at once. */
const SHA = '8bda7cef79563a1e094e77a52dd87743db513dad';
const PRODUCTION_HOST = 'my-app-prod111.vercel.app';
const PREVIEW_HOST = 'my-app-prev222.vercel.app';
const PRODUCTION_ID = 'dpl_ProductionDeployment';
const PREVIEW_ID = 'dpl_PreviewDeployment';

interface Fixture {
	/** Environments this SHA has a GitHub Deployment in. */
	environments?: string[];
	/** Host in the environment-scoped GitHub Deployment status. */
	statusHost?: string;
	/** Deployment ID embedded in the `Vercel – <project>` commit status. */
	commitStatusId?: string;
	/** `target` the Vercel API reports for each host. */
	targets?: Record<string, string | null>;
	/** IDs the Vercel API reports for each host. */
	ids?: Record<string, string>;
	/** Environments whose GitHub Deployment listing returns a 500. */
	failEnvironments?: string[];
}

function setInputs(inputs: Record<string, string>): void {
	for (const [k, v] of Object.entries(inputs)) {
		process.env[`INPUT_${k.toUpperCase().replace(/ /g, '_')}`] = v;
	}
}

/**
 * A GitHub client backed by the multi-environment fixture, plus the Vercel
 * fetch stub the action uses for host lookups.
 */
function harness(fixture: Fixture = {}) {
	const {
		environments = ['Production – my-app', 'Preview – my-app'],
		statusHost = PRODUCTION_HOST,
		commitStatusId = PREVIEW_ID,
		targets = { [PRODUCTION_HOST]: 'production', [PREVIEW_HOST]: null },
		ids = { [PRODUCTION_HOST]: PRODUCTION_ID, [PREVIEW_HOST]: PREVIEW_ID },
		failEnvironments = [],
	} = fixture;

	const githubCalls: string[] = [];
	const vercelCalls: string[] = [];

	const githubFetch = ((url: string) => {
		githubCalls.push(url);
		const json = (body: unknown) =>
			Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			);

		if (url.includes('/deployments?')) {
			const environment = decodeURIComponent(
				new URL(url).searchParams.get('environment') ?? '',
			);
			if (failEnvironments.includes(environment)) {
				return Promise.resolve(new Response('boom', { status: 500 }));
			}
			return json(
				environments.includes(environment)
					? [{ id: 1, sha: SHA, ref: 'main', environment, task: 'deploy' }]
					: [],
			);
		}
		if (url.includes('/statuses')) {
			return json([
				{
					state: 'success',
					environment: 'Production – my-app',
					environment_url: `https://${statusHost}`,
					target_url: `https://${statusHost}`,
				},
			]);
		}
		// Combined commit status: one entry per project, last writer wins.
		return json({
			state: 'success',
			statuses: [
				{
					context: 'Vercel – my-app',
					state: 'success',
					target_url: `https://vercel.com/team/my-app/${commitStatusId.replace('dpl_', '')}`,
				},
			],
		});
	}) as unknown as typeof fetch;

	const vercelFetch = ((url: URL) => {
		vercelCalls.push(url.toString());
		const host = decodeURIComponent(
			url.pathname.replace('/v13/deployments/', ''),
		);
		const id = ids[host];
		if (!id) {
			return Promise.resolve(
				new Response(JSON.stringify({ error: { code: 'not_found' } }), {
					status: 404,
				}),
			);
		}
		return Promise.resolve(
			new Response(JSON.stringify({ id, url: host, target: targets[host] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
	}) as unknown as typeof fetch;

	return {
		client: new GitHubClient('ghs_test', githubFetch),
		vercelFetch,
		githubCalls,
		vercelCalls,
	};
}

describe('run', () => {
	let outputs: Record<string, string>;
	let warnings: string[];
	let failures: string[];
	let infos: string[];

	beforeEach(() => {
		outputs = {};
		warnings = [];
		failures = [];
		infos = [];
		vi.spyOn(core, 'setOutput').mockImplementation((k, v) => {
			outputs[k] = v;
		});
		vi.spyOn(core, 'warning').mockImplementation((m) => {
			warnings.push(m);
		});
		vi.spyOn(core, 'setFailed').mockImplementation((m) => {
			failures.push(m);
		});
		vi.spyOn(core, 'info').mockImplementation((m) => {
			infos.push(m);
		});

		for (const key of Object.keys(process.env)) {
			if (key.startsWith('INPUT_')) delete process.env[key];
		}
		process.env.GITHUB_REPOSITORY = 'octocat/hello';
		process.env.GITHUB_SHA = SHA;
		delete process.env.GITHUB_EVENT_NAME;
		delete process.env.GITHUB_EVENT_PATH;
		delete process.env.VERCEL_TOKEN;
		delete process.env.VERCEL_TEAM_ID;
		setInputs({
			'github-token': 'ghs_test',
			'project-slug': 'my-app',
			environment: 'production',
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = { ...originalEnv };
	});

	describe('with a vercel-token', () => {
		it('resolves the ID from the deployment URL, not the commit status', async () => {
			// The regression: the commit status names the preview deployment of
			// the same SHA. The production URL must still yield the production ID.
			const h = harness();
			setInputs({ 'vercel-token': 'vercel_test', 'vercel-team-id': 'team_x' });

			await run({ client: h.client, vercelFetch: h.vercelFetch });

			expect(failures).toEqual([]);
			expect(outputs['deployment-url']).toBe(`https://${PRODUCTION_HOST}`);
			expect(outputs['deployment-id']).toBe(PRODUCTION_ID);
			expect(outputs['deployment-id']).not.toBe(PREVIEW_ID);
			// The commit status is never consulted on this path.
			expect(h.githubCalls.some((u) => u.includes('/commits/'))).toBe(false);
			expect(h.vercelCalls[0]).toContain(PRODUCTION_HOST);
			expect(h.vercelCalls[0]).toContain('teamId=team_x');
		});

		it('fails when the resolved deployment is in the wrong environment', async () => {
			// production requested, but the environment-scoped URL resolves to a
			// preview deployment — something is wired wrong; refuse to guess.
			const h = harness({
				statusHost: PREVIEW_HOST,
				ids: { [PREVIEW_HOST]: PREVIEW_ID },
				targets: { [PREVIEW_HOST]: null },
			});
			setInputs({ 'vercel-token': 'vercel_test' });

			await run({ client: h.client, vercelFetch: h.vercelFetch });

			expect(failures).toHaveLength(1);
			expect(failures[0]).toMatch(/Environment mismatch/);
			expect(outputs['deployment-id']).toBeUndefined();
			expect(outputs['deployment-url']).toBeUndefined();
		});

		it('fails on an environment mismatch even with require-deployment-id false', async () => {
			const h = harness({
				statusHost: PREVIEW_HOST,
				ids: { [PREVIEW_HOST]: PREVIEW_ID },
				targets: { [PREVIEW_HOST]: null },
			});
			setInputs({
				'vercel-token': 'vercel_test',
				'require-deployment-id': 'false',
			});

			await run({ client: h.client, vercelFetch: h.vercelFetch });

			expect(failures[0]).toMatch(/Environment mismatch/);
		});

		it('skips the environment check when environment-name is overridden', async () => {
			const h = harness({
				environments: ['Custom Env'],
				statusHost: PREVIEW_HOST,
				ids: { [PREVIEW_HOST]: PREVIEW_ID },
				targets: { [PREVIEW_HOST]: null },
			});
			setInputs({
				'vercel-token': 'vercel_test',
				'environment-name': 'Custom Env',
			});

			await run({ client: h.client, vercelFetch: h.vercelFetch });

			expect(failures).toEqual([]);
			expect(outputs['deployment-id']).toBe(PREVIEW_ID);
			expect(infos.join('\n')).toMatch(/Skipping the environment check/);
		});

		it('does not fall back to the commit status when the lookup fails', async () => {
			// Falling back here would silently reintroduce the mismatched pair.
			const h = harness({ ids: {} });
			setInputs({ 'vercel-token': 'vercel_test' });

			await run({ client: h.client, vercelFetch: h.vercelFetch });

			expect(failures).toHaveLength(1);
			expect(failures[0]).toMatch(/Vercel API 404/);
			expect(outputs['deployment-id']).toBeUndefined();
		});
	});

	describe('without a vercel-token', () => {
		it('ignores ambient VERCEL_TOKEN / VERCEL_TEAM_ID and stays on the commit-status path', async () => {
			// An ambient job-level env var must not switch resolution modes:
			// only the explicit `vercel-token` input engages the Vercel API.
			const h = harness();
			process.env.VERCEL_TOKEN = 'vercel_from_env';
			process.env.VERCEL_TEAM_ID = 'team_from_env';

			await run({ client: h.client, vercelFetch: h.vercelFetch });

			expect(h.vercelCalls).toHaveLength(0);
			expect(outputs['deployment-id']).toBe(PREVIEW_ID);
		});

		it('still resolves from the commit status, and warns loudly when the SHA spans environments', async () => {
			const h = harness();

			await run({ client: h.client });

			expect(failures).toEqual([]);
			// Unchanged (wrong) ID: the fallback cannot do better, so it warns.
			expect(outputs['deployment-id']).toBe(PREVIEW_ID);
			expect(warnings.join('\n')).toMatch(
				/was deployed to both "Production – my-app" and "Preview – my-app"/,
			);
			expect(warnings.join('\n')).toMatch(
				/durable fix is to stop deploying one commit to multiple environments/,
			);
		});

		it('does not warn at all when the SHA is in one environment only', async () => {
			// The hazard needs the commit to span environments. Having just
			// checked and ruled that out, a warning annotation would be noise.
			const h = harness({ environments: ['Production – my-app'] });

			await run({ client: h.client });

			expect(failures).toEqual([]);
			expect(warnings).toEqual([]);
			expect(infos.join('\n')).toMatch(
				/was not deployed to "Preview – my-app", so that status is unambiguous/,
			);
		});

		it('still resolves when the counterpart-environment check itself errors', async () => {
			// The ambiguity check is advisory; a failing GitHub call must not
			// take the run down with it — but it does leave the hazard unruled
			// out, so it warns.
			const h = harness({ failEnvironments: ['Preview – my-app'] });

			await run({ client: h.client });

			expect(failures).toEqual([]);
			expect(outputs['deployment-id']).toBe(PREVIEW_ID);
			expect(warnings.join('\n')).toMatch(
				/Could not check whether .* was also deployed to "Preview – my-app"/,
			);
		});

		it('skips the counterpart check for a hand-written environment-name', async () => {
			const h = harness({ environments: ['Custom Env'] });
			setInputs({ 'environment-name': 'Custom Env' });

			await run({ client: h.client });

			expect(failures).toEqual([]);
			expect(outputs['deployment-id']).toBe(PREVIEW_ID);
			// Only the target environment is listed; no counterpart is derivable.
			expect(
				h.githubCalls.filter((u) => u.includes('/deployments?')),
			).toHaveLength(1);
			// Nothing ruled the hazard out, so the warning stands.
			expect(warnings.join('\n')).toMatch(
				/keeps a single "Vercel – my-app" commit status per project/,
			);
		});

		it('says up front that the ID is best effort under require-deployment-id: false', async () => {
			// `require-deployment-id: false` downgrades a failure to a warning,
			// it does not skip the lookup — the log should not imply otherwise.
			const h = harness();
			setInputs({ 'require-deployment-id': 'false' });

			await run({ client: h.client });

			expect(failures).toEqual([]);
			expect(outputs['deployment-id']).toBe(PREVIEW_ID);
			expect(infos.join('\n')).toMatch(
				/commit status \(best effort: `require-deployment-id` is false/,
			);
		});
	});
});
