import {
	type Config,
	counterpartEnvironmentName,
	resolveConfig,
} from './config.ts';
import * as core from './core.ts';
import {
	GitHubClient,
	type GitHubDeployment,
	type GitHubDeploymentStatus,
	resolveDeploymentId,
} from './github.ts';
import {
	assertEnvironmentMatches,
	describeTarget,
	EnvironmentMismatchError,
	getDeploymentByHost,
	hostFromDeploymentUrl,
} from './vercel.ts';

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
	/** Override for the Vercel API transport (used in tests). */
	vercelFetch?: typeof fetch;
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
		if (config.vercelToken) {
			core.info(
				'Will resolve the deployment ID from the Vercel API, keyed on the deployment URL',
			);
		} else if (config.statusContext) {
			core.info(
				`Will resolve the deployment ID from the "${config.statusContext}" commit status${
					config.requireDeploymentId
						? ''
						: ' (best effort: `require-deployment-id` is false, so a failure to resolve only warns)'
				}`,
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

			// 3. Resolve the provider deployment ID for that exact URL.
			let deploymentId = '';
			if (config.vercelToken || config.statusContext) {
				try {
					const resolved = await resolveDeploymentIdFor(
						client,
						config,
						deploymentUrl,
						deps.vercelFetch,
					);
					if (resolved) {
						deploymentId = resolved;
					} else if (config.requireDeploymentId) {
						// Only the commit-status path can come back empty; the
						// Vercel API path either resolves or throws.
						throw new Error(
							`Deployment became ready at ${deploymentUrl}, but the deployment ID could not be resolved from the "${config.statusContext}" commit status`,
						);
					} else {
						core.warning(
							`No "${config.statusContext}" commit status with a target_url found; deployment-id will be empty.`,
						);
					}
				} catch (err) {
					// An environment mismatch is always fatal: it means the URL
					// we were about to emit isn't the environment that was asked
					// for, so suppressing it would hand downstream steps a
					// plausible but wrong deployment.
					if (err instanceof EnvironmentMismatchError) throw err;
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

/**
 * Resolve the Vercel deployment ID of the deployment serving `deploymentUrl`,
 * or `''` when it can't be determined.
 *
 * With a `vercel-token` this is exact: the URL's host is looked up against the
 * Vercel API, so `deployment-id` and `deployment-url` always describe the same
 * deployment, and the deployment's environment is verified.
 *
 * Without one it falls back to the commit status, which is per-project rather
 * than per-environment and can therefore name a different deployment of the
 * same commit. See `src/vercel.ts` for the full failure mode.
 */
async function resolveDeploymentIdFor(
	client: GitHubClient,
	config: Config,
	deploymentUrl: string,
	vercelFetch?: typeof fetch,
): Promise<string> {
	if (config.vercelToken) {
		const host = hostFromDeploymentUrl(deploymentUrl);
		const deployment = await getDeploymentByHost(host, {
			token: config.vercelToken,
			teamId: config.vercelTeamId,
			...(vercelFetch ? { fetchImpl: vercelFetch } : {}),
		});

		if (config.environmentNameOverridden) {
			core.info(
				`Skipping the environment check: \`environment-name\` was set explicitly, so the intended Vercel target is ambiguous. Resolved target: ${describeTarget(deployment.target)}.`,
			);
		} else {
			assertEnvironmentMatches(deployment, config.environment, host);
			core.info(
				`Verified ${host} is a ${describeTarget(deployment.target)} deployment, matching the requested "${config.environment}" environment`,
			);
		}
		return deployment.id;
	}

	if (!config.statusContext) return '';
	await noteCommitStatusAmbiguity(client, config);
	return (
		(await resolveDeploymentId(client, {
			owner: config.owner,
			repo: config.repo,
			sha: config.sha,
			context: config.statusContext,
		})) ?? ''
	);
}

/**
 * Report that the commit-status fallback can name the wrong deployment.
 *
 * The status is only actually ambiguous when this commit was deployed to more
 * than one environment of the project, so the severity follows that check: a
 * warning when the risk is real or can't be ruled out, and an informational
 * line when it's ruled out — otherwise every tokenless run of a
 * single-environment commit would carry a warning annotation for a hazard that
 * was just checked and found absent. The check costs one extra GitHub call
 * (`deployments: read`, already required) and never fails the run.
 */
async function noteCommitStatusAmbiguity(
	client: GitHubClient,
	config: Config,
): Promise<void> {
	const shared = `Vercel keeps a single "${config.statusContext}" commit status per project rather than per environment, overwritten by whichever deployment finished last, so the deployment-id read from it can belong to a different deployment than deployment-url.`;
	const advice =
		'Pass `vercel-token` (plus `vercel-team-id` for team-owned projects) to resolve the ID from `deployment-url` instead, which cannot disagree.';

	const counterpart = counterpartEnvironmentName(config.environmentName);
	// A hand-written `environment-name` has no derivable counterpart, so
	// there's no cheap way to rule the hazard out.
	if (!counterpart) {
		core.warning(`${shared} ${advice}`);
		return;
	}

	let alsoDeployed: GitHubDeployment[];
	try {
		alsoDeployed = await client.listDeployments({
			owner: config.owner,
			repo: config.repo,
			sha: config.sha,
			environment: counterpart,
		});
	} catch (err) {
		core.warning(
			`${shared} Could not check whether ${config.sha} was also deployed to "${counterpart}": ${(err as Error).message}. ${advice}`,
		);
		return;
	}

	if (alsoDeployed.length > 0) {
		core.warning(
			`Commit ${config.sha} was deployed to both "${config.environmentName}" and "${counterpart}". ${shared} ${advice}`,
		);
		return;
	}

	core.info(
		`Resolving deployment-id from the "${config.statusContext}" commit status. ${config.sha} was not deployed to "${counterpart}", so that status is unambiguous for this commit. ${advice}`,
	);
}
