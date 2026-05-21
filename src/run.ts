import { resolveConfig } from './config.ts';
import * as core from './core.ts';
import {
	GitHubClient,
	type GitHubDeployment,
	type GitHubDeploymentStatus,
	resolveDeploymentId,
} from './github.ts';

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

const TERMINAL_OK_STATES = new Set(['success', 'inactive']);
const TERMINAL_FAIL_STATES = new Set(['error', 'failure']);

export interface RunDeps {
	/** Override for the current-time clock (used in tests). */
	now?: () => number;
	/** Override for the polling sleep (used in tests). */
	sleep?: (ms: number) => Promise<void>;
	/** Pre-built GitHub client (used in tests to inject fixtures). */
	client?: GitHubClient;
}

/**
 * Run the action body. Catches all errors and reports them via
 * `core.setFailed`, mirroring the GitHub Actions convention of one
 * top-level handler.
 */
export async function run(deps: RunDeps = {}): Promise<void> {
	const now = deps.now ?? Date.now;
	const wait = deps.sleep ?? sleep;
	try {
		const config = resolveConfig();
		const client = deps.client ?? new GitHubClient(config.githubToken);

		core.info(`Repo: ${config.owner}/${config.repo}`);
		core.info(`Target SHA: ${config.sha}`);
		core.info(
			`Looking for GitHub deployment in environment "${config.environmentName}"`,
		);
		if (config.statusContext) {
			core.info(
				`Will resolve deployment ID from "${config.statusContext}" commit status`,
			);
		} else {
			core.info('Deployment ID resolution disabled (status-context is empty)');
		}
		core.info(
			`Timeout: ${config.timeout}s, Check interval: ${config.checkInterval}s`,
		);

		const deadline = now() + config.timeout * 1000;
		let attempt = 0;

		while (now() < deadline) {
			attempt++;
			core.info(`Attempt ${attempt}`);

			// 1. Find the GitHub Deployment for (sha, environment).
			let deployment: GitHubDeployment | undefined;
			try {
				const deployments = await client.listDeployments({
					owner: config.owner,
					repo: config.repo,
					sha: config.sha,
					environment: config.environmentName,
				});
				deployment = deployments[0];
			} catch (err) {
				core.warning(`Failed to list deployments: ${(err as Error).message}`);
				await wait(config.checkInterval * 1000);
				continue;
			}
			if (!deployment) {
				core.info(
					`No GitHub Deployment yet for SHA ${config.sha} env "${config.environmentName}"`,
				);
				await wait(config.checkInterval * 1000);
				continue;
			}

			// 2. Read its latest status.
			let latest: GitHubDeploymentStatus | undefined;
			try {
				const statuses = await client.listDeploymentStatuses({
					owner: config.owner,
					repo: config.repo,
					deploymentId: deployment.id,
				});
				latest = statuses[0];
			} catch (err) {
				core.warning(
					`Failed to list deployment statuses: ${(err as Error).message}`,
				);
				await wait(config.checkInterval * 1000);
				continue;
			}
			if (!latest) {
				core.info(`Deployment ${deployment.id} has no statuses yet`);
				await wait(config.checkInterval * 1000);
				continue;
			}

			core.info(
				`Deployment ${deployment.id} state: ${latest.state}${
					latest.description ? ` (${latest.description})` : ''
				}`,
			);

			if (TERMINAL_FAIL_STATES.has(latest.state)) {
				throw new Error(
					`Deployment failed (state=${latest.state})${
						latest.description ? `: ${latest.description}` : ''
					}`,
				);
			}

			// Both `success` and `inactive` are terminal-OK. Vercel emits
			// `inactive` immediately when it skips a build ("Skipped - Not
			// affected"), and the `environment_url` in that status points to
			// the still-live previously-deployed URL.
			if (!TERMINAL_OK_STATES.has(latest.state)) {
				await wait(config.checkInterval * 1000);
				continue;
			}

			const deploymentUrl = latest.environment_url || latest.target_url;
			if (!deploymentUrl) {
				core.warning(
					`Deployment status was "${latest.state}" but had no environment_url; retrying`,
				);
				await wait(config.checkInterval * 1000);
				continue;
			}

			// 3. Resolve the provider deployment ID from the commit status.
			let deploymentId = '';
			if (config.statusContext) {
				try {
					const resolved = await resolveDeploymentId(client, {
						owner: config.owner,
						repo: config.repo,
						sha: config.sha,
						context: config.statusContext,
					});
					if (resolved) {
						deploymentId = resolved;
					} else if (config.requireDeploymentId) {
						throw new Error(
							`Deployment became ready at ${deploymentUrl}, but the deployment ID could not be resolved from the "${config.statusContext}" commit status`,
						);
					} else {
						core.warning(
							`No "${config.statusContext}" commit status with a target_url found; deployment-id will be empty.`,
						);
					}
				} catch (err) {
					// Re-throw the "required but unresolved" error; warn on
					// transport failures so the rest of the run still emits.
					if (config.requireDeploymentId) throw err;
					core.warning(
						`Failed to resolve deployment ID: ${(err as Error).message}`,
					);
				}
			}

			core.info(`Deployment ready: ${deploymentUrl}`);
			if (deploymentId) core.info(`Deployment ID: ${deploymentId}`);
			core.setOutput('deployment-url', deploymentUrl);
			core.setOutput('deployment-id', deploymentId);
			core.setOutput('deployment-state', latest.state);
			return;
		}

		throw new Error(
			`Timeout reached after ${config.timeout}s waiting for deployment to be ready`,
		);
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}
