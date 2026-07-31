# wait-for-deployment-action

GitHub Action that waits for a [Vercel](https://vercel.com) deployment to be ready in CI, then exposes its URL and deployment ID as step outputs.

It works entirely off GitHub's [Deployments API](https://docs.github.com/en/rest/deployments/deployments) and commit statuses, which Vercel's GitHub integration writes to — so it needs no Vercel credentials, just the default `GITHUB_TOKEN`.

## Why

- **No Vercel token required.** Both outputs, URL and deployment ID, come from GitHub. Auths with `GITHUB_TOKEN`, rotates with your repo.
- **Robust against Vercel skipped builds.** Vercel emits an `inactive` GitHub Deployment status when it skips a build with "Skipped – Not affected"; the action treats that as ready and surfaces the still-live preview URL.
- **Resolves the `dpl_xxx` deployment ID**, so downstream steps that need the Vercel deployment ID (e.g. to drive `world-vercel`) work out of the box.
- **Says so when that ID could name the wrong environment.** GitHub only carries the ID on a per-project commit status, so it's ambiguous when one commit is deployed to two environments of the project — the action checks for exactly that and warns. See [Resolving the deployment ID](#resolving-the-deployment-id).

## Usage

### Single-project repo (most common)

For a repo with exactly one Vercel project connected, just declare the action — sensible defaults match Vercel's naming.

```yaml
permissions:
  contents: read
  deployments: read
  statuses: read

steps:
  - name: Wait for Vercel preview
    id: deployment
    uses: vercel/wait-for-deployment-action@<commit-sha>
    with:
      environment: preview          # or "production"

  - name: Smoke-test the preview
    run: curl --fail "$URL/api/health"
    env:
      URL: ${{ steps.deployment.outputs.deployment-url }}
```

### Monorepo / multi-project repo

When the same repo serves more than one Vercel project, Vercel suffixes the GitHub Deployment environment and commit status context with the project slug. Pass `project-slug` to disambiguate:

```yaml
- uses: vercel/wait-for-deployment-action@<commit-sha>
  with:
    project-slug: my-tarballs       # → "Preview – my-tarballs" / "Vercel – my-tarballs"
    environment: ${{ github.ref == 'refs/heads/main' && 'production' || 'preview' }}
```

## Resolving the deployment ID

Waiting for a deployment only needs GitHub. Naming *which* Vercel deployment you ended up with is harder, because the two things Vercel publishes to GitHub carry different granularity:

| What Vercel publishes | Scope | Carries |
|---|---|---|
| A GitHub **Deployment** (+ statuses) | one per project **per environment** | the deployment's URL — but an empty `payload`, so no ID |
| A GitHub **commit status** (`Vercel – <project>`) | one per project, **all environments share it** | the deployment ID, in its `target_url` |

The commit status is overwritten by whichever deployment of that commit finishes last. So when one commit is deployed to more than one environment, an ID read from it can name a different deployment than the environment-scoped URL:

> A release branch is force-pushed to `main`'s HEAD. Vercel builds that one commit twice — production from `main`, and a preview from the branch. The preview finishes last, so the commit status names the preview. A job waiting on `environment: production` gets the **production URL** paired with the **preview ID**, and every downstream step keyed on that ID silently addresses the wrong environment.

### Default: the commit status, with an ambiguity check

No token, no configuration. The ID comes from the commit status, and since that status is only ambiguous when the commit went to more than one environment, the action checks whether it did — one extra call against the `deployments: read` scope it already needs:

| What the check finds | What you get |
|---|---|
| The commit was deployed to this environment only | The ID, and a log line naming the status it read |
| The commit was **also** deployed to the project's other environment | The ID, plus a **warning** that it may name the other environment's deployment |
| The check can't run or errors | The ID, plus that same warning — an unruled-out hazard shouldn't be quieter than a confirmed one |

A hand-written `environment-name` is the "can't run" case: there's no derivable counterpart environment to compare against.

The durable fix for a warning is upstream, not here — stop deploying one commit to two environments of the same project. It usually means two branches point at the same SHA (a release branch force-pushed to `main`'s HEAD, say), and excluding one of them from deployment removes the ambiguity at the source.

If you only need `deployment-url`, set `require-deployment-id: false` and ignore `deployment-id`. That downgrades a failed resolution to a warning rather than skipping the lookup, so the ID is still emitted when it can be determined.

### Escape hatch: `vercel-token`

Only worth reaching for if you already hold a Vercel access token for other reasons — needing one is what this action is designed to avoid, and the check above is enough for most consumers. With a token the ID is resolved by looking the deployment **URL** up against the Vercel API, so the ID and the URL cannot disagree, and the deployment's environment is checked against `environment`, failing the job if they don't match.

```yaml
- uses: vercel/wait-for-deployment-action@<commit-sha>
  id: deployment
  with:
    project-slug: my-app
    environment: production
    vercel-token: ${{ secrets.VERCEL_TOKEN }}
    vercel-team-id: ${{ vars.VERCEL_TEAM_ID }}   # required for team-owned projects
```

`vercel-team-id` is not optional for a project owned by a Vercel team: the API answers `404` (not `403`) for a team's deployments when the request isn't scoped to that team. A read-only token is enough.

The token is read from the input only. Neither credential falls back to a `VERCEL_TOKEN` / `VERCEL_TEAM_ID` environment variable, so an ambient token in your job env can't quietly switch resolution modes — pass `vercel-token: ${{ env.VERCEL_TOKEN }}` if that's what you want.

### Backward compatibility

Nothing changes for existing workflows. Passing no `vercel-token` keeps the commit-status path and the same `deployment-id`, including in the ambiguous case — the action reports the hazard, it doesn't refuse it. The only new output on that path is the log line or warning from the check, and it needs no permission you weren't already granting.

## Permissions

The workflow's `permissions:` block must include:

```yaml
permissions:
  contents: read
  deployments: read   # always required
  statuses: read      # required when resolving deployment-id without vercel-token
```

If you supply a token via `github-token`, those scopes apply to whatever auth the token represents instead.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `project-slug` | no | _empty_ | Set when the repo serves multiple Vercel projects. Suffixes the auto-composed environment name and status context with `– <slug>`. |
| `environment` | no | `preview` | `production` or `preview`. Ignored when `environment-name` is set. |
| `environment-name` | no | auto | **Advanced.** Match the GitHub Deployment environment name exactly. Overrides auto-compose. |
| `status-context` | no | auto | **Advanced.** Match the commit status context exactly. Only consulted without `vercel-token`. |
| `require-deployment-id` | no | `true` | Fail if the deployment-id cannot be resolved. Does not suppress an environment mismatch. |
| `timeout` | no | `600` | Max wait time in seconds. |
| `check-interval` | no | `10` | Polling interval in seconds. |
| `sha` | no | auto | Commit SHA to look up. Defaults to PR head SHA / push SHA / `GITHUB_SHA`. |
| `github-token` | no | `${{ github.token }}` | Token used for the GitHub API calls. |
| `vercel-token` | no | _empty_ | **Escape hatch; most consumers don't need it.** Vercel access token. Resolves `deployment-id` from `deployment-url` and verifies the deployment's environment. See [Resolving the deployment ID](#resolving-the-deployment-id). |
| `vercel-team-id` | no | _empty_ | Vercel team (`team_...`) that owns the project. Only used alongside `vercel-token`, where it is required for team-owned projects. |

### Auto-composition rules

The defaults follow Vercel's GitHub integration's naming.

| Input | `project-slug` set | `project-slug` empty |
|-------|--------------------|----------------------|
| `environment-name` | `Preview – <slug>` / `Production – <slug>` | `Preview` / `Production` |
| `status-context` | `Vercel – <slug>` | `Vercel` |

## Outputs

| Name | Description |
|------|-------------|
| `deployment-url` | URL of the ready deployment (`environment_url`, falling back to `target_url`). |
| `deployment-id` | Vercel deployment ID of the deployment serving `deployment-url` (e.g. `dpl_8z4XjwrRQGYwcDKFMLN5BeTvGhXu`). Empty when resolution failed and `require-deployment-id` is `false`. |
| `deployment-state` | Terminal GitHub Deployment status state (`success` or `inactive`). |

`inactive` is treated as success: Vercel emits it when it skips a build with "Skipped – Not affected", and the associated `environment_url` points to the still-live previously-deployed URL.

## How it works

1. Polls `GET /repos/{owner}/{repo}/deployments?sha=<sha>&environment=<env-name>` until a GitHub Deployment created by Vercel exists for the head commit.
2. Polls `GET /repos/{owner}/{repo}/deployments/{id}/statuses` until the latest status is terminal (`success`, `inactive`, `error`, or `failure`).
3. Resolves the deployment ID for the URL from step 2:
   - **With `vercel-token`:** `GET https://api.vercel.com/v13/deployments/<url-host>` (the endpoint takes a deployment host in place of an ID) and uses the returned `id`. The returned `target` is checked against `environment` — `production` for production, anything else (`null`, which is how the API spells "preview", plus `staging` and custom environments) for preview — and a mismatch fails the job.
   - **Without one:** fetches `GET /repos/{owner}/{repo}/commits/{sha}/status`, finds the status whose context is `<status-context>` (default `Vercel`), and takes the last path segment of its `target_url`, prepending `dpl_`. Because that status is shared across environments, the action first checks whether the commit was also deployed to the project's other environment, and warns when it was — or when the check can't run.

Setting `environment-name` disables the environment check in the `vercel-token` path: a hand-written environment name can't be mapped back to a Vercel target, so there is nothing sound to compare against.

## Pinning

Pin to a commit SHA so you control upgrades:

```yaml
uses: vercel/wait-for-deployment-action@abc123def4567...
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build              # produces dist/index.js (committed)
```

The bundle is a single ESM file produced by `esbuild`, targeting Node 24 (the GitHub Actions JavaScript runtime). Production code lives under `src/`; tests live under `test/`.

## License

MIT — see [LICENSE](./LICENSE).
