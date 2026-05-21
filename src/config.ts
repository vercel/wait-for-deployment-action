import * as fs from 'node:fs';
import * as core from './core.ts';

export interface Config {
	owner: string;
	repo: string;
	sha: string;
	environmentName: string;
	statusContext: string;
	requireDeploymentId: boolean;
	timeout: number;
	checkInterval: number;
	githubToken: string;
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
	const statusContextOverride = core.getInput('status-context');
	const statusContextProvided = isInputProvided('status-context');

	const environmentName =
		envNameOverride || composeEnvironmentName(environment, projectSlug);

	// `status-context` semantics:
	// - not provided at all → use auto-compose default (Vercel / Vercel – slug)
	// - provided as empty string → opt out of deployment-id resolution entirely
	// - provided as non-empty string → use as-is
	const statusContext = statusContextProvided
		? statusContextOverride
		: composeStatusContext(projectSlug);

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

	const { owner, repo } = getRepo();
	const sha = core.getInput('sha').trim() || resolveTargetSha();

	return {
		owner,
		repo,
		sha,
		environmentName,
		statusContext,
		requireDeploymentId,
		timeout,
		checkInterval,
		githubToken,
	};
}

export function composeEnvironmentName(
	environment: 'production' | 'preview',
	projectSlug: string,
): string {
	const base = environment === 'production' ? 'Production' : 'Preview';
	return projectSlug ? `${base} – ${projectSlug}` : base;
}

export function composeStatusContext(projectSlug: string): string {
	return projectSlug ? `Vercel – ${projectSlug}` : 'Vercel';
}

function isInputProvided(name: string): boolean {
	// `core.getInput` returns '' for both unset and explicitly-empty inputs,
	// so we have to look at the underlying env var to distinguish them.
	// GitHub Actions uppercases the input name and replaces spaces with `_`
	// (dashes are preserved); see
	// https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions#example-specifying-inputs
	const envName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
	return Object.hasOwn(process.env, envName);
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
