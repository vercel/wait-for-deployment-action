/**
 * Tiny replacement for the subset of `@actions/core` we need:
 * `getInput`, `setOutput`, `setFailed`, `info`, `warning`.
 *
 * Avoids pulling in `@actions/http-client` and its transitive
 * `undici` dependency through `@actions/core`'s OIDC helpers, which we
 * never use. Same behavior as the real package for the supported subset.
 *
 * GitHub Actions reference:
 * - Input env vars: https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions#example-specifying-inputs
 * - Workflow commands: https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions
 */

import * as fs from 'node:fs';
import { EOL } from 'node:os';

const COMMAND_PREFIX = '::';

/**
 * Read an action input. Mirrors `@actions/core.getInput`:
 * - Input names are converted by GitHub Actions to env vars by uppercasing
 *   and replacing spaces with `_` (dashes are preserved).
 * - Leading/trailing whitespace is trimmed unless `trimWhitespace: false`.
 */
export function getInput(
	name: string,
	options: { trimWhitespace?: boolean } = {},
): string {
	const envName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
	const raw = process.env[envName] ?? '';
	return options.trimWhitespace === false ? raw : raw.trim();
}

/**
 * Set a step output. Writes to `GITHUB_OUTPUT` if available; falls back
 * to the deprecated `::set-output::` workflow command for local runs.
 */
export function setOutput(name: string, value: string): void {
	const file = process.env.GITHUB_OUTPUT;
	if (file) {
		fs.appendFileSync(file, formatKeyValue(name, value), 'utf8');
		return;
	}
	process.stdout.write(
		`${COMMAND_PREFIX}set-output name=${name}${COMMAND_PREFIX}${escapeData(value)}${EOL}`,
	);
}

/** Log a regular info-level message. */
export function info(message: string): void {
	process.stdout.write(`${message}${EOL}`);
}

/** Log a warning-level message as a GitHub Actions annotation. */
export function warning(message: string): void {
	process.stdout.write(
		`${COMMAND_PREFIX}warning${COMMAND_PREFIX}${escapeData(message)}${EOL}`,
	);
}

/** Mark the step as failed with an error-level annotation. */
export function setFailed(message: string): void {
	process.exitCode = 1;
	process.stdout.write(
		`${COMMAND_PREFIX}error${COMMAND_PREFIX}${escapeData(message)}${EOL}`,
	);
}

/**
 * Format a heredoc-style key/value entry for `GITHUB_OUTPUT`. The
 * delimiter must not appear in either the key or value; we use a
 * random suffix to make collisions astronomically unlikely.
 */
function formatKeyValue(key: string, value: string): string {
	const delimiter = `ghadelimiter_${randomDelimiter()}`;
	if (key.includes(delimiter) || value.includes(delimiter)) {
		throw new Error(
			`Output key/value cannot contain the random delimiter ${delimiter}`,
		);
	}
	return `${key}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`;
}

function randomDelimiter(): string {
	// 16 random hex chars (~64 bits) is plenty of entropy here.
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Escape special characters in workflow command data per the GitHub
 * Actions runner's parsing rules.
 */
function escapeData(s: string): string {
	return s
		.replaceAll('%', '%25')
		.replaceAll('\r', '%0D')
		.replaceAll('\n', '%0A');
}
