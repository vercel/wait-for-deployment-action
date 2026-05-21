import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, resolveDeploymentId } from '../src/github.ts';

function makeFetch(
	handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
	return ((url: string, init?: RequestInit) =>
		Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

describe('GitHubClient', () => {
	it('sets the expected headers on every request', async () => {
		const seen: Record<string, string>[] = [];
		const fetchImpl = makeFetch((_url, init) => {
			seen.push(init?.headers as Record<string, string>);
			return new Response('[]', { status: 200 });
		});
		const client = new GitHubClient('ghs_test', fetchImpl);
		await client.listDeployments({
			owner: 'o',
			repo: 'r',
			sha: 'abc',
			environment: 'Preview',
		});
		expect(seen[0]).toMatchObject({
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			Authorization: 'Bearer ghs_test',
			'User-Agent': 'wait-for-deployment-action',
		});
	});

	it('encodes path / query parameters', async () => {
		let capturedUrl = '';
		const fetchImpl = makeFetch((url) => {
			capturedUrl = url;
			return new Response('[]', { status: 200 });
		});
		const client = new GitHubClient('t', fetchImpl);
		await client.listDeployments({
			owner: 'o',
			repo: 'r',
			sha: 'abc',
			environment: 'Preview – my app',
		});
		expect(capturedUrl).toBe(
			'https://api.github.com/repos/o/r/deployments?sha=abc&environment=Preview%20%E2%80%93%20my%20app&per_page=1',
		);
	});

	it('throws with the response body included on non-2xx', async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response('{"message":"Not Found"}', {
					status: 404,
					statusText: 'Not Found',
				}),
		);
		const client = new GitHubClient('t', fetchImpl);
		await expect(
			client.listDeployments({
				owner: 'o',
				repo: 'r',
				sha: 'x',
				environment: 'Preview',
			}),
		).rejects.toThrow(/404 Not Found[\s\S]*Not Found/);
	});
});

describe('resolveDeploymentId', () => {
	function clientReturning(combined: unknown) {
		return new GitHubClient(
			't',
			makeFetch(
				() =>
					new Response(JSON.stringify(combined), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
			),
		);
	}

	it('extracts the inspector ID from the target_url last segment and prepends dpl_', async () => {
		const client = clientReturning({
			state: 'success',
			statuses: [
				{
					context: 'Vercel',
					state: 'success',
					target_url:
						'https://vercel.com/vercel/workflow-server/8z4XjwrRQGYwcDKFMLN5BeTvGhXu',
				},
			],
		});
		const id = await resolveDeploymentId(client, {
			owner: 'o',
			repo: 'r',
			sha: 'x',
			context: 'Vercel',
		});
		expect(id).toBe('dpl_8z4XjwrRQGYwcDKFMLN5BeTvGhXu');
	});

	it('matches on context exactly', async () => {
		const client = clientReturning({
			state: 'success',
			statuses: [
				{
					context: 'Vercel – workflow-server',
					state: 'success',
					target_url: 'https://vercel.com/team/proj/abc123',
				},
				{ context: 'Vercel', state: 'success', target_url: 'wrong' },
			],
		});
		const id = await resolveDeploymentId(client, {
			owner: 'o',
			repo: 'r',
			sha: 'x',
			context: 'Vercel – workflow-server',
		});
		expect(id).toBe('dpl_abc123');
	});

	it('returns null when no matching context is present', async () => {
		const client = clientReturning({ state: 'pending', statuses: [] });
		const id = await resolveDeploymentId(client, {
			owner: 'o',
			repo: 'r',
			sha: 'x',
			context: 'Vercel',
		});
		expect(id).toBeNull();
	});

	it('returns null when the matching status has no target_url', async () => {
		const client = clientReturning({
			state: 'success',
			statuses: [{ context: 'Vercel', state: 'success', target_url: null }],
		});
		const id = await resolveDeploymentId(client, {
			owner: 'o',
			repo: 'r',
			sha: 'x',
			context: 'Vercel',
		});
		expect(id).toBeNull();
	});

	it('returns null when target_url is unparseable', async () => {
		const client = clientReturning({
			state: 'success',
			statuses: [
				{ context: 'Vercel', state: 'success', target_url: 'not a url' },
			],
		});
		const id = await resolveDeploymentId(client, {
			owner: 'o',
			repo: 'r',
			sha: 'x',
			context: 'Vercel',
		});
		expect(id).toBeNull();
	});
});

// Avoid a vitest warning about an unused import:
void vi;
