// src/config.ts
import * as fs2 from "node:fs";

// src/core.ts
import * as fs from "node:fs";
import { EOL } from "node:os";
var COMMAND_PREFIX = "::";
function getInput(name, options = {}) {
  const envName = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const raw = process.env[envName] ?? "";
  return options.trimWhitespace === false ? raw : raw.trim();
}
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    fs.appendFileSync(file, formatKeyValue(name, value), "utf8");
    return;
  }
  process.stdout.write(
    `${COMMAND_PREFIX}set-output name=${name}${COMMAND_PREFIX}${escapeData(value)}${EOL}`
  );
}
function info(message) {
  process.stdout.write(`${message}${EOL}`);
}
function warning(message) {
  process.stdout.write(
    `${COMMAND_PREFIX}warning${COMMAND_PREFIX}${escapeData(message)}${EOL}`
  );
}
function setFailed(message) {
  process.exitCode = 1;
  process.stdout.write(
    `${COMMAND_PREFIX}error${COMMAND_PREFIX}${escapeData(message)}${EOL}`
  );
}
function formatKeyValue(key, value) {
  const delimiter = `ghadelimiter_${randomDelimiter()}`;
  if (key.includes(delimiter) || value.includes(delimiter)) {
    throw new Error(
      `Output key/value cannot contain the random delimiter ${delimiter}`
    );
  }
  return `${key}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`;
}
function randomDelimiter() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function escapeData(s) {
  return s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

// src/config.ts
function resolveConfig() {
  const projectSlug = getInput("project-slug").trim();
  const environment = (getInput("environment") || "preview").toLowerCase();
  if (environment !== "production" && environment !== "preview") {
    throw new Error(
      `environment must be "production" or "preview" (got "${environment}")`
    );
  }
  const envNameOverride = getInput("environment-name").trim();
  const statusContextOverride = getInput("status-context").trim();
  const environmentName = envNameOverride || composeEnvironmentName(environment, projectSlug);
  const statusContext = statusContextOverride || composeStatusContext(projectSlug);
  const requireDeploymentId = parseBool(
    getInput("require-deployment-id"),
    true
  );
  const timeout = parsePositiveInt(getInput("timeout"), 600);
  const checkInterval = parsePositiveInt(getInput("check-interval"), 10);
  const githubToken = getInput("github-token") || process.env.GITHUB_TOKEN || "";
  if (!githubToken) {
    throw new Error("github-token input or GITHUB_TOKEN env var is required");
  }
  const vercelToken = getInput("vercel-token") || process.env.VERCEL_TOKEN || "";
  const vercelTeamId = getInput("vercel-team-id") || process.env.VERCEL_TEAM_ID || "";
  const { owner, repo } = getRepo();
  const sha = getInput("sha").trim() || resolveTargetSha();
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
    vercelTeamId
  };
}
function composeEnvironmentName(environment, projectSlug) {
  const base = environment === "production" ? "Production" : "Preview";
  return projectSlug ? `${base} \u2013 ${projectSlug}` : base;
}
function counterpartEnvironmentName(environmentName) {
  const match = environmentName.match(/^(Production|Preview)(?=$|\s)/);
  if (!match?.[1]) return null;
  const base = match[1] === "Production" ? "Preview" : "Production";
  return `${base}${environmentName.slice(match[1].length)}`;
}
function composeStatusContext(projectSlug) {
  return projectSlug ? `Vercel \u2013 ${projectSlug}` : "Vercel";
}
function parseBool(raw, fallback) {
  const v = raw.trim().toLowerCase();
  if (v === "") return fallback;
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  throw new Error(`expected a boolean, got "${raw}"`);
}
function parsePositiveInt(raw, fallback) {
  if (raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function getRepo() {
  const repoFull = process.env.GITHUB_REPOSITORY;
  if (!repoFull) throw new Error("GITHUB_REPOSITORY env var is not set");
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repoFull}`);
  }
  return { owner, repo };
}
function resolveTargetSha() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const fallbackSha = process.env.GITHUB_SHA;
  if (eventPath && fs2.existsSync(eventPath)) {
    try {
      const event = JSON.parse(fs2.readFileSync(eventPath, "utf8"));
      if (eventName === "pull_request" && event.pull_request?.head?.sha) {
        return event.pull_request.head.sha;
      }
      if (eventName === "push" && typeof event.after === "string") {
        return event.after;
      }
    } catch (err) {
      warning(
        `Could not read GitHub event payload: ${err.message}`
      );
    }
  }
  if (!fallbackSha) {
    throw new Error(
      "Could not resolve target commit SHA from event context. Set the `sha` input explicitly."
    );
  }
  return fallbackSha;
}

// src/github.ts
var API_BASE = "https://api.github.com";
var USER_AGENT = "wait-for-deployment-action";
var GitHubClient = class {
  #token;
  #fetch;
  constructor(token, fetchImpl = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }
  async listDeployments(params) {
    const { owner, repo, sha, environment, perPage = 1 } = params;
    const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments?sha=${encodeURIComponent(sha)}&environment=${encodeURIComponent(environment)}&per_page=${perPage}`;
    return await this.#json(url);
  }
  async listDeploymentStatuses(params) {
    const { owner, repo, deploymentId, perPage = 10 } = params;
    const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments/${deploymentId}/statuses?per_page=${perPage}`;
    return await this.#json(url);
  }
  async getCombinedStatus(params) {
    const { owner, repo, ref, perPage = 100 } = params;
    const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/status?per_page=${perPage}`;
    return await this.#json(url);
  }
  async #json(url) {
    const res = await this.#fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${this.#token}`,
        "User-Agent": USER_AGENT
      }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `GitHub API ${res.status} ${res.statusText} for ${url}${body ? `
${body}` : ""}`
      );
    }
    return await res.json();
  }
};
var VERCEL_DEPLOYMENT_ID_PREFIX = "dpl_";
async function resolveDeploymentId(client, params) {
  const status = await client.getCombinedStatus({
    owner: params.owner,
    repo: params.repo,
    ref: params.sha
  });
  const match = status.statuses.find((s) => s.context === params.context);
  if (!match?.target_url) return null;
  let pathname;
  try {
    pathname = new URL(match.target_url).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split("/").filter(Boolean);
  const inspectorId = segments.at(-1);
  if (!inspectorId) return null;
  return `${VERCEL_DEPLOYMENT_ID_PREFIX}${inspectorId}`;
}

// src/vercel.ts
var API_BASE2 = "https://api.vercel.com";
var DEPLOYMENT_ID_PATTERN = /^dpl_[A-Za-z0-9]+$/;
var EnvironmentMismatchError = class extends Error {
  name = "EnvironmentMismatchError";
};
function hostFromDeploymentUrl(deploymentUrl) {
  let host;
  try {
    host = new URL(deploymentUrl).hostname;
  } catch {
    throw new Error(
      `Could not parse a hostname out of the deployment URL "${deploymentUrl}"`
    );
  }
  if (!host) {
    throw new Error(`Deployment URL "${deploymentUrl}" has no hostname`);
  }
  return host;
}
async function getDeploymentByHost(host, lookup) {
  const doFetch = lookup.fetchImpl ?? fetch;
  const url = new URL(
    `${API_BASE2}/v13/deployments/${encodeURIComponent(host)}`
  );
  if (lookup.teamId) url.searchParams.set("teamId", lookup.teamId);
  const res = await doFetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${lookup.token}`,
      "User-Agent": "wait-for-deployment-action"
    }
  });
  if (!res.ok) {
    throw new Error(await describeApiError(res, host, lookup.teamId));
  }
  const body = await res.json();
  if (typeof body !== "object" || body === null) {
    throw new Error(`Vercel API returned a non-object body for "${host}"`);
  }
  const { id, url: deploymentUrl, target } = body;
  if (typeof id !== "string" || !DEPLOYMENT_ID_PATTERN.test(id)) {
    throw new Error(
      `Vercel API returned an unexpected deployment ID for "${host}": ${JSON.stringify(id)}`
    );
  }
  return {
    id,
    ...typeof deploymentUrl === "string" ? { url: deploymentUrl } : {},
    target: typeof target === "string" ? target : null
  };
}
function assertEnvironmentMatches(deployment, environment, host) {
  const isProduction = deployment.target === "production";
  if (isProduction === (environment === "production")) return;
  throw new EnvironmentMismatchError(
    `Environment mismatch: waited for the "${environment}" deployment, but ${host} resolves to Vercel deployment ${deployment.id}, whose target is ${JSON.stringify(deployment.target)} (${describeTarget(deployment.target)}). This is what a same-commit multi-environment deployment looks like; refusing to emit a deployment-id / deployment-url pair from the wrong environment. Check that \`environment\` (and \`project-slug\`) name the deployment you meant to wait for.`
  );
}
function describeTarget(target) {
  return target === null ? "preview" : target;
}
async function describeApiError(res, host, teamId) {
  const body = await res.text().catch(() => "");
  const suffix = body ? `
${body}` : "";
  if (res.status === 404) {
    return teamId ? `Vercel API 404 for deployment host "${host}". Check that the deployment exists and that \`vercel-team-id\` ("${teamId}") is the team that owns it.${suffix}` : `Vercel API 404 for deployment host "${host}". If a Vercel team owns this project, set the \`vercel-team-id\` input \u2014 team-owned deployments answer 404 (not 403) when the request isn't scoped to their team.${suffix}`;
  }
  if (res.status === 401 || res.status === 403) {
    return `Vercel API ${res.status} for deployment host "${host}". The \`vercel-token\` is invalid, expired, or lacks access to this project.${suffix}`;
  }
  return `Vercel API ${res.status} ${res.statusText} for deployment host "${host}".${suffix}`;
}

// src/run.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var TERMINAL_OK_STATES = /* @__PURE__ */ new Set(["success", "inactive"]);
var TERMINAL_FAIL_STATES = /* @__PURE__ */ new Set(["error", "failure"]);
async function run(deps = {}) {
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  try {
    const config = resolveConfig();
    const client = deps.client ?? new GitHubClient(config.githubToken);
    info(`Repo: ${config.owner}/${config.repo}`);
    info(`Target SHA: ${config.sha}`);
    info(
      `Looking for GitHub deployment in environment "${config.environmentName}"`
    );
    if (config.vercelToken) {
      info(
        "Will resolve the deployment ID from the Vercel API, keyed on the deployment URL"
      );
    } else if (config.statusContext) {
      info(
        `Will resolve the deployment ID from the "${config.statusContext}" commit status`
      );
    } else {
      info("Deployment ID resolution disabled (status-context is empty)");
    }
    info(
      `Timeout: ${config.timeout}s, Check interval: ${config.checkInterval}s`
    );
    const deadline = now() + config.timeout * 1e3;
    let attempt = 0;
    while (now() < deadline) {
      attempt++;
      info(`Attempt ${attempt}`);
      let deployment;
      try {
        const deployments = await client.listDeployments({
          owner: config.owner,
          repo: config.repo,
          sha: config.sha,
          environment: config.environmentName
        });
        deployment = deployments[0];
      } catch (err) {
        warning(`Failed to list deployments: ${err.message}`);
        await wait(config.checkInterval * 1e3);
        continue;
      }
      if (!deployment) {
        info(
          `No GitHub Deployment yet for SHA ${config.sha} env "${config.environmentName}"`
        );
        await wait(config.checkInterval * 1e3);
        continue;
      }
      let latest;
      try {
        const statuses = await client.listDeploymentStatuses({
          owner: config.owner,
          repo: config.repo,
          deploymentId: deployment.id
        });
        latest = statuses[0];
      } catch (err) {
        warning(
          `Failed to list deployment statuses: ${err.message}`
        );
        await wait(config.checkInterval * 1e3);
        continue;
      }
      if (!latest) {
        info(`Deployment ${deployment.id} has no statuses yet`);
        await wait(config.checkInterval * 1e3);
        continue;
      }
      info(
        `Deployment ${deployment.id} state: ${latest.state}${latest.description ? ` (${latest.description})` : ""}`
      );
      if (TERMINAL_FAIL_STATES.has(latest.state)) {
        throw new Error(
          `Deployment failed (state=${latest.state})${latest.description ? `: ${latest.description}` : ""}`
        );
      }
      if (!TERMINAL_OK_STATES.has(latest.state)) {
        await wait(config.checkInterval * 1e3);
        continue;
      }
      const deploymentUrl = latest.environment_url || latest.target_url;
      if (!deploymentUrl) {
        warning(
          `Deployment status was "${latest.state}" but had no environment_url; retrying`
        );
        await wait(config.checkInterval * 1e3);
        continue;
      }
      let deploymentId = "";
      if (config.vercelToken || config.statusContext) {
        try {
          const resolved = await resolveDeploymentIdFor(
            client,
            config,
            deploymentUrl,
            deps.vercelFetch
          );
          if (resolved) {
            deploymentId = resolved;
          } else if (config.requireDeploymentId) {
            throw new Error(
              `Deployment became ready at ${deploymentUrl}, but the deployment ID could not be resolved from the "${config.statusContext}" commit status`
            );
          } else {
            warning(
              `No "${config.statusContext}" commit status with a target_url found; deployment-id will be empty.`
            );
          }
        } catch (err) {
          if (err instanceof EnvironmentMismatchError) throw err;
          if (config.requireDeploymentId) throw err;
          warning(
            `Failed to resolve deployment ID: ${err.message}`
          );
        }
      }
      info(`Deployment ready: ${deploymentUrl}`);
      if (deploymentId) info(`Deployment ID: ${deploymentId}`);
      setOutput("deployment-url", deploymentUrl);
      setOutput("deployment-id", deploymentId);
      setOutput("deployment-state", latest.state);
      return;
    }
    throw new Error(
      `Timeout reached after ${config.timeout}s waiting for deployment to be ready`
    );
  } catch (error) {
    setFailed(error instanceof Error ? error.message : String(error));
  }
}
async function resolveDeploymentIdFor(client, config, deploymentUrl, vercelFetch) {
  if (config.vercelToken) {
    const host = hostFromDeploymentUrl(deploymentUrl);
    const deployment = await getDeploymentByHost(host, {
      token: config.vercelToken,
      teamId: config.vercelTeamId,
      ...vercelFetch ? { fetchImpl: vercelFetch } : {}
    });
    if (config.environmentNameOverridden) {
      info(
        `Skipping the environment check: \`environment-name\` was set explicitly, so the intended Vercel target is ambiguous. Resolved target: ${describeTarget(deployment.target)}.`
      );
    } else {
      assertEnvironmentMatches(deployment, config.environment, host);
      info(
        `Verified ${host} is a ${describeTarget(deployment.target)} deployment, matching the requested "${config.environment}" environment`
      );
    }
    return deployment.id;
  }
  if (!config.statusContext) return "";
  await warnAboutCommitStatusAmbiguity(client, config);
  return await resolveDeploymentId(client, {
    owner: config.owner,
    repo: config.repo,
    sha: config.sha,
    context: config.statusContext
  }) ?? "";
}
async function warnAboutCommitStatusAmbiguity(client, config) {
  const counterpart = counterpartEnvironmentName(config.environmentName);
  const advice = "Pass `vercel-token` (plus `vercel-team-id` for team-owned projects) to resolve the ID from `deployment-url` instead, which cannot disagree.";
  if (counterpart) {
    try {
      const alsoDeployed = await client.listDeployments({
        owner: config.owner,
        repo: config.repo,
        sha: config.sha,
        environment: counterpart
      });
      if (alsoDeployed.length > 0) {
        warning(
          `Commit ${config.sha} was deployed to both "${config.environmentName}" and "${counterpart}". Vercel keeps a single "${config.statusContext}" commit status per project, overwritten by whichever deployment finished last, so the deployment-id read from it may belong to the ${counterpart} deployment rather than the one at deployment-url. ${advice}`
        );
        return;
      }
    } catch (err) {
      info(
        `Could not check whether ${config.sha} was also deployed to "${counterpart}": ${err.message}`
      );
    }
  }
  warning(
    `Resolving deployment-id from the "${config.statusContext}" commit status. Vercel keeps one such status per project rather than per environment, so if this commit is deployed to more than one environment the ID can belong to a different deployment than deployment-url. ${advice}`
  );
}

// src/main.ts
await run();
