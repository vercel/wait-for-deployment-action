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
  const { owner, repo } = getRepo();
  const sha = getInput("sha").trim() || resolveTargetSha();
  return {
    owner,
    repo,
    sha,
    environmentName,
    statusContext,
    requireDeploymentId,
    timeout,
    checkInterval,
    githubToken
  };
}
function composeEnvironmentName(environment, projectSlug) {
  const base = environment === "production" ? "Production" : "Preview";
  return projectSlug ? `${base} \u2013 ${projectSlug}` : base;
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
    if (config.statusContext) {
      info(
        `Will resolve deployment ID from "${config.statusContext}" commit status`
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
      if (config.statusContext) {
        try {
          const resolved = await resolveDeploymentId(client, {
            owner: config.owner,
            repo: config.repo,
            sha: config.sha,
            context: config.statusContext
          });
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

// src/main.ts
await run();
