import assert from 'node:assert/strict';

const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;

export type VercelDeploymentIdSource = {
	type: 'vercel';
	token: string;
	teamId: string | null;
};

export async function resolveDeploymentIdFromUrl(
	deploymentUrl: string,
	source: VercelDeploymentIdSource,
): Promise<string> {
	const hostname = new URL(deploymentUrl).hostname;
	const url = new URL(
		`https://api.vercel.com/v13/deployments/${encodeURIComponent(hostname)}`,
	);
	if (source.teamId) url.searchParams.set('teamId', source.teamId);

	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${source.token}` },
	});
	assert(response.ok, `Vercel API returned ${response.status} for ${hostname}`);

	const deployment: unknown = await response.json();
	assert(
		typeof deployment === 'object' &&
			deployment !== null &&
			'id' in deployment &&
			typeof deployment.id === 'string' &&
			DEPLOYMENT_ID.test(deployment.id),
		'Vercel API returned an invalid deployment ID',
	);
	return deployment.id;
}
