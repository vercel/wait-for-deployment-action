import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDeploymentIdFromUrl } from '../src/vercel.ts';

afterEach(() => vi.unstubAllGlobals());

describe('resolveDeploymentIdFromUrl', () => {
	it('looks up the exact deployment hostname', async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ id: 'dpl_production' })),
		);
		vi.stubGlobal('fetch', fetchMock);

		const id = await resolveDeploymentIdFromUrl(
			'https://app-production.vercel.app',
			{ type: 'vercel', token: 'vercel_test', teamId: 'team_test' },
		);

		expect(id).toBe('dpl_production');
		expect(fetchMock).toHaveBeenCalledWith(
			new URL(
				'https://api.vercel.com/v13/deployments/app-production.vercel.app?teamId=team_test',
			),
			{ headers: { Authorization: 'Bearer vercel_test' } },
		);
	});
});
