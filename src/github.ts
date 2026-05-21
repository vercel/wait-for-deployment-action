export interface GitHubDeployment {
	id: number;
	sha: string;
	ref: string;
	environment: string;
	task: string;
	created_at: string;
	updated_at: string;
}

export interface GitHubDeploymentStatus {
	state:
		| 'error'
		| 'failure'
		| 'inactive'
		| 'in_progress'
		| 'queued'
		| 'pending'
		| 'success';
	environment: string;
	environment_url?: string;
	target_url?: string;
	log_url?: string;
	description?: string;
	created_at: string;
	updated_at: string;
}

export interface GitHubCommitStatus {
	context: string;
	state: string;
	target_url?: string | null;
	description?: string | null;
}

export interface GitHubCombinedStatus {
	state: string;
	statuses: GitHubCommitStatus[];
}

interface RepoRef {
	owner: string;
	repo: string;
}

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'wait-for-deployment-action';

/**
 * Thin HTTPS client for the subset of GitHub REST endpoints we need.
 * Uses Node's global `fetch` directly (no undici / @actions/http-client)
 * so the bundle stays small and free of transitive vuln surface.
 */
export class GitHubClient {
	#token: string;
	#fetch: typeof fetch;

	constructor(token: string, fetchImpl: typeof fetch = fetch) {
		this.#token = token;
		this.#fetch = fetchImpl;
	}

	async listDeployments(
		params: RepoRef & { sha: string; environment: string; perPage?: number },
	): Promise<GitHubDeployment[]> {
		const { owner, repo, sha, environment, perPage = 1 } = params;
		const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments?sha=${encodeURIComponent(sha)}&environment=${encodeURIComponent(environment)}&per_page=${perPage}`;
		return await this.#json<GitHubDeployment[]>(url);
	}

	async listDeploymentStatuses(
		params: RepoRef & { deploymentId: number; perPage?: number },
	): Promise<GitHubDeploymentStatus[]> {
		const { owner, repo, deploymentId, perPage = 10 } = params;
		const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments/${deploymentId}/statuses?per_page=${perPage}`;
		return await this.#json<GitHubDeploymentStatus[]>(url);
	}

	async getCombinedStatus(
		params: RepoRef & { ref: string; perPage?: number },
	): Promise<GitHubCombinedStatus> {
		const { owner, repo, ref, perPage = 100 } = params;
		const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/status?per_page=${perPage}`;
		return await this.#json<GitHubCombinedStatus>(url);
	}

	async #json<T>(url: string): Promise<T> {
		const res = await this.#fetch(url, {
			headers: {
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				Authorization: `Bearer ${this.#token}`,
				'User-Agent': USER_AGENT,
			},
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(
				`GitHub API ${res.status} ${res.statusText} for ${url}${body ? `\n${body}` : ''}`,
			);
		}
		return (await res.json()) as T;
	}
}

const VERCEL_DEPLOYMENT_ID_PREFIX = 'dpl_';

/**
 * Look up the Vercel deployment ID from the commit's combined status.
 * Vercel posts a per-project commit status with a `target_url` of the
 * form `https://vercel.com/<team>/<project>/<inspectorId>`; the
 * inspector ID is the deployment ID without the `dpl_` prefix.
 */
export async function resolveDeploymentId(
	client: GitHubClient,
	params: {
		owner: string;
		repo: string;
		sha: string;
		context: string;
	},
): Promise<string | null> {
	const status = await client.getCombinedStatus({
		owner: params.owner,
		repo: params.repo,
		ref: params.sha,
	});
	const match = status.statuses.find((s) => s.context === params.context);
	if (!match?.target_url) return null;
	let pathname: string;
	try {
		pathname = new URL(match.target_url).pathname;
	} catch {
		return null;
	}
	const segments = pathname.split('/').filter(Boolean);
	const inspectorId = segments.at(-1);
	if (!inspectorId) return null;
	return `${VERCEL_DEPLOYMENT_ID_PREFIX}${inspectorId}`;
}
