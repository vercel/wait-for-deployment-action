import { describe, expect, it } from 'vitest';
import { deploymentIdFromTargetUrl, GitHubClient } from '../src/github.ts';

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

describe('deploymentIdFromTargetUrl', () => {
	it('extracts the ID from a Vercel dashboard deployment URL', () => {
		expect(
			deploymentIdFromTargetUrl(
				'https://vercel.com/vercel/workflow-server/8z4XjwrRQGYwcDKFMLN5BeTvGhXu',
			),
		).toBe('dpl_8z4XjwrRQGYwcDKFMLN5BeTvGhXu');
	});

	it('rejects deployment app URLs and malformed dashboard URLs', () => {
		expect(
			deploymentIdFromTargetUrl('https://workflow-server-abc123.vercel.app'),
		).toBeNull();
		expect(
			deploymentIdFromTargetUrl('https://vercel.com/team/project'),
		).toBeNull();
		expect(deploymentIdFromTargetUrl('not a url')).toBeNull();
	});
});
