# Vibe-Agent: strict mirror + workline runbook

## Branch contract
- `main`: mirror-only branch. No local development or PR merges.
- `work/main`: integration/deploy branch for all custom changes.
- `feature/*`: short-lived branches that open PRs into `work/main`.
- Repository default branch: `work/main` (required so scheduled workflow runs without modifying mirror-only `main`).

## One-time setup

```bash
set -euo pipefail

# If not cloned yet
git clone https://github.com/lin-mouren/Vibe-Agent.git
cd Vibe-Agent

# Ensure remotes
git remote set-url origin https://github.com/lin-mouren/Vibe-Agent.git
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream https://github.com/yuyou-dev/Vibe-Agent.git
else
  git remote add upstream https://github.com/yuyou-dev/Vibe-Agent.git
fi

# Block accidental push to upstream
git remote set-url --push upstream DISABLED

# Recommended repo-level git config
git config --local fetch.prune true
git config --local remote.origin.prune true
git config --local remote.upstream.prune true
git config --local pull.rebase true
git config --local pull.ff only
git config --local rebase.autoStash true
git config --local branch.autoSetupRebase always
git config --local push.default current

# Verify
git remote -v
git fetch --prune origin
git fetch --prune upstream
git rev-parse origin/main
git rev-parse upstream/main
```

## Daily operation

### 1) Sync mirror `main` (fast-forward only)

```bash
set -euo pipefail
git fetch --prune origin
git fetch --prune upstream
git switch main
git merge --ff-only upstream/main
git push origin main
```

### 2) Update `work/main` (rebase on `origin/main`)

```bash
set -euo pipefail
git fetch --prune origin
git switch work/main
git rebase origin/main
git push --force-with-lease origin work/main
```

### 3) Feature flow

```bash
set -euo pipefail

# Create new feature branch
git switch work/main
git pull --rebase origin work/main
git switch -c feature/<topic>

# Periodic rebase while developing
git fetch --prune origin
git rebase origin/work/main
git push --force-with-lease -u origin feature/<topic>

# Open PR: feature -> work/main
gh pr create --base work/main --head feature/<topic> --fill
```

## CI mirror workflow
- File: `.github/workflows/mirror-upstream-main.yml`
- Secret required: `MIRROR_TOKEN`
- Recommended token: fine-grained PAT with `Contents: Read and write` on `lin-mouren/Vibe-Agent`
- If upstream repo is private: token also needs read access to `yuyou-dev/Vibe-Agent`

Set the secret:

```bash
gh secret set MIRROR_TOKEN --repo lin-mouren/Vibe-Agent --body '<your-token>'
```

## Break-glass (only when ff-only fails)

### Diagnose divergence

```bash
set -euo pipefail
git fetch --prune origin
git fetch --prune upstream
git rev-list --left-right --count origin/main...upstream/main
git log --oneline --graph --decorate --left-right origin/main...upstream/main
```

Interpretation:
- `0 N`: origin behind upstream, normal fast-forward is possible.
- `N 0` or `N M`: origin ahead/diverged, break-glass is required.

### Force realign `origin/main` (high risk: rewrites history)

Preconditions in GitHub settings:
- Temporarily allow force push on `main` for admin/bot only.
- Ruleset/branch protection allows bypass for the token actor.
- Re-disable force push immediately after realignment.

```bash
set -euo pipefail
git fetch --prune origin
git fetch --prune upstream
OLD="$(git rev-parse origin/main)"
NEW="$(git rev-parse upstream/main)"

# Risky operation: rewrite origin/main to upstream/main
git push --force-with-lease=refs/heads/main:${OLD} origin ${NEW}:refs/heads/main
```

## Acceptance checks

```bash
git fetch --prune origin
git fetch --prune upstream
test "$(git rev-parse origin/main)" = "$(git rev-parse upstream/main)"
```
