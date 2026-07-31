# wait-for-deployment-action

GitHub Action that waits for a [Vercel](https://vercel.com) deployment to be ready in CI, then exposes its URL and deployment ID as step outputs.

Instead of polling the Vercel API (which needs a Vercel access token), it polls **GitHub's** [Deployments API](https://docs.github.com/en/rest/deployments/deployments) — Vercel's GitHub integration publishes everything we need there. That means no Vercel token to provision, and the action authenticates with the default `GITHUB_TOKEN`.

## Why

- **No Vercel token to manage.** Auths with `GITHUB_TOKEN`. Rotates with your repo.
- **Robust against Vercel skipped builds.** Vercel emits an `inactive` GitHub Deployment status when it skips a build with "Skipped – Not affected"; the action treats that as ready and surfaces the still-live preview URL.
- **Keeps deployment URL and ID paired** by reading `environment_url` and the dashboard `target_url` from the same GitHub Deployment status.

## Usage

### Single-project repo (most common)

For a repo with exactly one Vercel project connected, just declare the action — sensible defaults match Vercel's naming.

```yaml
permissions:
  contents: read
  deployments: read

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

When the same repo serves more than one Vercel project, Vercel suffixes the GitHub Deployment environment with the project slug. Pass `project-slug` to disambiguate:

```yaml
- uses: vercel/wait-for-deployment-action@<commit-sha>
  with:
    project-slug: my-tarballs       # → "Preview – my-tarballs"
    environment: ${{ github.ref == 'refs/heads/main' && 'production' || 'preview' }}
```

## Permissions

The workflow's `permissions:` block must include:

```yaml
permissions:
  contents: read
  deployments: read
```

If you supply a token via `github-token`, those scopes apply to whatever auth the token represents instead.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `project-slug` | no | _empty_ | Set when the repo serves multiple Vercel projects. Suffixes the auto-composed environment name with `– <slug>`. |
| `environment` | no | `preview` | `production` or `preview`. Ignored when `environment-name` is set. |
| `environment-name` | no | auto | **Advanced.** Match the GitHub Deployment environment name exactly. Overrides auto-compose. |
| `status-context` | no | _empty_ | Deprecated and ignored; retained so existing callers do not receive a warning. |
| `require-deployment-id` | no | `true` | Fail if the deployment-id cannot be resolved. |
| `timeout` | no | `600` | Max wait time in seconds. |
| `check-interval` | no | `10` | Polling interval in seconds. |
| `sha` | no | auto | Commit SHA to look up. Defaults to PR head SHA / push SHA / `GITHUB_SHA`. |
| `github-token` | no | `${{ github.token }}` | Token used for the GitHub API calls. |

### Auto-composition rules

The defaults follow Vercel's GitHub integration's naming.

`environment-name` defaults to `Preview – <slug>` / `Production – <slug>`
when `project-slug` is set, and `Preview` / `Production` otherwise.

## Outputs

| Name | Description |
|------|-------------|
| `deployment-url` | URL of the ready deployment (`environment_url`). |
| `deployment-id` | Vercel deployment ID (e.g. `dpl_8z4XjwrRQGYwcDKFMLN5BeTvGhXu`). Empty when resolution failed and `require-deployment-id` is `false`. |
| `deployment-state` | Terminal GitHub Deployment status state (`success` or `inactive`). |

`inactive` is treated as success: Vercel emits it when it skips a build with "Skipped – Not affected", and the associated `environment_url` points to the still-live previously-deployed URL.

## How it works

1. Polls `GET /repos/{owner}/{repo}/deployments?sha=<sha>&environment=<env-name>` until a GitHub Deployment created by Vercel exists for the head commit.
2. Polls `GET /repos/{owner}/{repo}/deployments/{id}/statuses` until the latest status is terminal (`success`, `inactive`, `error`, or `failure`).
3. On success, extracts the deployment URL from `environment_url` and its ID from the same status's Vercel dashboard `target_url`.

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
