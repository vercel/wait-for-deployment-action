import * as fs from 'node:fs';
import * as core from './core.ts';

export interface Config {
	owner: string;
	repo: string;
	sha: string;
	/** The logical environment asked for, before name composition. */
	environment: 'production' | 'preview';
	environmentName: string;
	/**
	 * Whether `environmentName` came from the `environment-name` escape hatch
	 * rather than being composed from `environment` + `project-slug`. When it
	 * did, `environment` no longer describes what the caller is waiting for, so
	 * the environment check against the Vercel API target is skipped.
	 */
	environmentNameOverridden: boolean;
	statusContext: string;
	requireDeploymentId: boolean;
	timeout: number;
	checkInterval: number;
	githubToken: string;
	vercelToken: string;
	vercelTeamId: string;
}

/**
 * Parse all action inputs + GitHub Actions environment into a typed config.
 * Throws on missing required values.
 *
 * The auto-composition rules below mirror Vercel's GitHub integration:
 * - Single project on a repo → bare `Preview` / `Vercel`.
 * - Multiple projects on a repo → suffixed `Preview – <slug>` / `Vercel – <slug>`.
 *
 * Either side of the heuristic can be overridden with the explicit
 * `environment-name` / `status-context` inputs.
 */
export function resolveConfig(): Config {
	const projectSlug = core.getInput('project-slug').trim();
	const environment = (core.getInput('environment') || 'preview').toLowerCase();
	if (environment !== 'production' && environment !== 'preview') {
		throw new Error(
			`environment must be "production" or "preview" (got "${environment}")`,
		);
	}

	const envNameOverride = core.getInput('environment-name').trim();
	const statusContextOverride = core.getInput('status-context').trim();

	const environmentName =
		envNameOverride || composeEnvironmentName(environment, projectSlug);

	// `status-context` follows the same empty-string-means-auto convention
	// as `environment-name`: empty (the action.yml default) → compose from
	// project-slug; non-empty → use the override as-is. Consumers that don't
	// need the ID should set `require-deployment-id: false` and not read the
	// `deployment-id` output — resolution is still attempted, but a failure
	// only warns.
	const statusContext =
		statusContextOverride || composeStatusContext(projectSlug);

	const requireDeploymentId = parseBool(
		core.getInput('require-deployment-id'),
		true,
	);

	const timeout = parsePositiveInt(core.getInput('timeout'), 600);
	const checkInterval = parsePositiveInt(core.getInput('check-interval'), 10);

	const githubToken =
		core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
	if (!githubToken) {
		throw new Error('github-token input or GITHUB_TOKEN env var is required');
	}
	// Both fall back to the conventional env var names, mirroring
	// `github-token` / `GITHUB_TOKEN` above.
	const vercelToken =
		core.getInput('vercel-token') || process.env.VERCEL_TOKEN || '';
	const vercelTeamId =
		core.getInput('vercel-team-id') || process.env.VERCEL_TEAM_ID || '';

	const { owner, repo } = getRepo();
	const sha = core.getInput('sha').trim() || resolveTargetSha();

	return {
		owner,
		repo,
		sha,
		environment,
		environmentName,
		environmentNameOverridden: Boolean(envNameOverride),
		statusContext,
		requireDeploymentId,
		timeout,
		checkInterval,
		githubToken,
		vercelToken,
		vercelTeamId,
	};
}

export function composeEnvironmentName(
	environment: 'production' | 'preview',
	projectSlug: string,
): string {
	const base = environment === 'production' ? 'Production' : 'Preview';
	return projectSlug ? `${base} – ${projectSlug}` : base;
}

/**
 * The same environment name with `Production` and `Preview` swapped —
 * `"Production – my-app"` becomes `"Preview – my-app"`. Used to check whether
 * the commit was *also* deployed to the other environment of the same project,
 * which is the precondition for the commit status being ambiguous.
 *
 * Returns `null` for names that don't follow Vercel's convention (a
 * hand-written `environment-name`), where no counterpart can be derived.
 */
export function counterpartEnvironmentName(
	environmentName: string,
): string | null {
	const match = environmentName.match(/^(Production|Preview)(?=$|\s)/);
	if (!match?.[1]) return null;
	const base = match[1] === 'Production' ? 'Preview' : 'Production';
	return `${base}${environmentName.slice(match[1].length)}`;
}

export function composeStatusContext(projectSlug: string): string {
	return projectSlug ? `Vercel – ${projectSlug}` : 'Vercel';
}

function parseBool(raw: string, fallback: boolean): boolean {
	const v = raw.trim().toLowerCase();
	if (v === '') return fallback;
	if (['true', '1', 'yes'].includes(v)) return true;
	if (['false', '0', 'no'].includes(v)) return false;
	throw new Error(`expected a boolean, got "${raw}"`);
}

function parsePositiveInt(raw: string, fallback: number): number {
	if (raw.trim() === '') return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getRepo(): { owner: string; repo: string } {
	const repoFull = process.env.GITHUB_REPOSITORY;
	if (!repoFull) throw new Error('GITHUB_REPOSITORY env var is not set');
	const [owner, repo] = repoFull.split('/');
	if (!owner || !repo) {
		throw new Error(`Invalid GITHUB_REPOSITORY: ${repoFull}`);
	}
	return { owner, repo };
}

function resolveTargetSha(): string {
	const eventName = process.env.GITHUB_EVENT_NAME;
	const eventPath = process.env.GITHUB_EVENT_PATH;
	const fallbackSha = process.env.GITHUB_SHA;

	if (eventPath && fs.existsSync(eventPath)) {
		try {
			const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
			if (eventName === 'pull_request' && event.pull_request?.head?.sha) {
				return event.pull_request.head.sha as string;
			}
			if (eventName === 'push' && typeof event.after === 'string') {
				return event.after;
			}
		} catch (err) {
			core.warning(
				`Could not read GitHub event payload: ${(err as Error).message}`,
			);
		}
	}

	if (!fallbackSha) {
		throw new Error(
			'Could not resolve target commit SHA from event context. Set the `sha` input explicitly.',
		);
	}
	return fallbackSha;
}
