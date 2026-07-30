/**
 * Authoritative deployment lookup against Vercel's REST API.
 *
 * Vercel's GitHub integration publishes two things for a commit, and they
 * carry different granularity:
 *
 * - A GitHub **Deployment** per (project, environment), whose status carries
 *   the deployment's URL but an empty `payload` — no deployment ID.
 * - A single GitHub **commit status** per project (`Vercel – <project>`),
 *   whose `target_url` embeds the deployment ID, and which is overwritten by
 *   whichever deployment of that SHA finishes last.
 *
 * So when one commit is deployed to more than one environment — e.g. a release
 * branch force-pushed to `main`'s HEAD, making Vercel build the same SHA once
 * for production (from `main`) and once as a preview (from the branch) — the ID
 * read from the commit status can belong to a different deployment than the
 * environment-scoped URL the action waited for.
 *
 * Looking the deployment up by the URL's host removes the ambiguity: the ID and
 * the URL then describe the same deployment by construction.
 */

const API_BASE = 'https://api.vercel.com';
const DEPLOYMENT_ID_PATTERN = /^dpl_[A-Za-z0-9]+$/;

export interface VercelDeployment {
	id: string;
	/** The deployment's own unique host, e.g. `my-app-a1b2c3.vercel.app`. */
	url?: string;
	/**
	 * Which environment the deployment was built for. Vercel documents
	 * `"production"`, `"staging"`, and `null` — where **`null` means a preview
	 * deployment**; there is no `"preview"` value. Typed as an open string so a
	 * future value (a custom environment, say) doesn't fail parsing.
	 */
	target: string | null;
}

export interface VercelLookup {
	token: string;
	/**
	 * Team that owns the project. Team-owned deployments are invisible without
	 * it: the API answers 404 rather than 403.
	 */
	teamId: string;
	fetchImpl?: typeof fetch;
}

/**
 * The resolved deployment belongs to a different environment than the one the
 * action was asked to wait for. Always fatal: it means the URL we were about to
 * emit does not describe what the caller asked for, so neither output can be
 * trusted.
 */
export class EnvironmentMismatchError extends Error {
	override name = 'EnvironmentMismatchError';
}

/** Extract the host to look up from a deployment URL. */
export function hostFromDeploymentUrl(deploymentUrl: string): string {
	let host: string;
	try {
		host = new URL(deploymentUrl).hostname;
	} catch {
		throw new Error(
			`Could not parse a hostname out of the deployment URL "${deploymentUrl}"`,
		);
	}
	if (!host) {
		throw new Error(`Deployment URL "${deploymentUrl}" has no hostname`);
	}
	return host;
}

/**
 * `GET /v13/deployments/{idOrUrl}` — the endpoint takes a deployment host in
 * place of an ID, which is what makes host-based resolution possible.
 */
export async function getDeploymentByHost(
	host: string,
	lookup: VercelLookup,
): Promise<VercelDeployment> {
	const doFetch = lookup.fetchImpl ?? fetch;
	const url = new URL(
		`${API_BASE}/v13/deployments/${encodeURIComponent(host)}`,
	);
	if (lookup.teamId) url.searchParams.set('teamId', lookup.teamId);

	const res = await doFetch(url, {
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${lookup.token}`,
			'User-Agent': 'wait-for-deployment-action',
		},
	});

	if (!res.ok) {
		throw new Error(await describeApiError(res, host, lookup.teamId));
	}

	const body: unknown = await res.json();
	if (typeof body !== 'object' || body === null) {
		throw new Error(`Vercel API returned a non-object body for "${host}"`);
	}
	const { id, url: deploymentUrl, target } = body as Record<string, unknown>;
	if (typeof id !== 'string' || !DEPLOYMENT_ID_PATTERN.test(id)) {
		throw new Error(
			`Vercel API returned an unexpected deployment ID for "${host}": ${JSON.stringify(id)}`,
		);
	}
	return {
		id,
		...(typeof deploymentUrl === 'string' ? { url: deploymentUrl } : {}),
		target: typeof target === 'string' ? target : null,
	};
}

/**
 * Fail unless the deployment's `target` agrees with the environment the action
 * was asked to wait for. This is the guard against cross-environment
 * crossover: it is what turns a silent wrong-ID failure into a loud one.
 *
 * The production side is exact (`target === 'production'`). The preview side
 * only requires "not production", so `staging` and custom environments — which
 * are preview-like and report something other than `production` — keep working.
 */
export function assertEnvironmentMatches(
	deployment: VercelDeployment,
	environment: 'production' | 'preview',
	host: string,
): void {
	const isProduction = deployment.target === 'production';
	if (isProduction === (environment === 'production')) return;

	throw new EnvironmentMismatchError(
		`Environment mismatch: waited for the "${environment}" deployment, but ${host} resolves to Vercel deployment ${deployment.id}, whose target is ${JSON.stringify(deployment.target)} (${describeTarget(deployment.target)}). ` +
			'This is what a same-commit multi-environment deployment looks like; refusing to emit a deployment-id / deployment-url pair from the wrong environment. ' +
			'Check that `environment` (and `project-slug`) name the deployment you meant to wait for.',
	);
}

/** Human-readable environment for a raw `target` value. */
export function describeTarget(target: string | null): string {
	return target === null ? 'preview' : target;
}

async function describeApiError(
	res: Response,
	host: string,
	teamId: string,
): Promise<string> {
	const body = await res.text().catch(() => '');
	const suffix = body ? `\n${body}` : '';

	if (res.status === 404) {
		return teamId
			? `Vercel API 404 for deployment host "${host}". Check that the deployment exists and that \`vercel-team-id\` ("${teamId}") is the team that owns it.${suffix}`
			: `Vercel API 404 for deployment host "${host}". If a Vercel team owns this project, set the \`vercel-team-id\` input — team-owned deployments answer 404 (not 403) when the request isn't scoped to their team.${suffix}`;
	}
	if (res.status === 401 || res.status === 403) {
		return `Vercel API ${res.status} for deployment host "${host}". The \`vercel-token\` is invalid, expired, or lacks access to this project.${suffix}`;
	}
	return `Vercel API ${res.status} ${res.statusText} for deployment host "${host}".${suffix}`;
}
