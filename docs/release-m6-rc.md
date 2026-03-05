# M6 RC Release Runbook (No Online Deployment)

## Purpose
M6 is a release-closure milestone for `work/main`:
- strict gate with mandatory mock path checks
- auditable evidence artifacts
- rollback rehearsal
- mirror governance alignment (`origin/main` mirrors `upstream/main`)

This milestone does **not** deploy to production.

## Release policy
- Branch policy: release workflow must run on `work/main`.
- Tag policy: create tag only after gate success.
- Tag format: `rc/m6-YYYYMMDD.N`
- Provider policy: mock path required, OpenAI canary optional and non-blocking.

## Required gate matrix
Mandatory:
1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm build`
4. `pnpm test:smoke:m3`
5. `pnpm test:smoke:m4`
6. `pnpm test:smoke:m5`
7. rollback drill rehearsal
8. mirror governance check (`origin/main == upstream/main`)

Optional:
1. OpenAI connectivity canary (runs only when requested and key exists)

## Trigger RC workflow
```bash
gh workflow run release-rc.yml \
  --repo lin-mouren/Vibe-Agent \
  --ref work/main \
  -f rc_tag=rc/m6-20260305.1 \
  -f run_openai_canary=false
```

Check latest runs:
```bash
gh run list --repo lin-mouren/Vibe-Agent --workflow release-rc.yml --limit 5
```

## Evidence artifacts
Workflow uploads two artifacts:
1. `release-evidence.json` (machine readable)
2. `release-summary.md` (human readable)

The release can move forward only when summary decision is `GO`.

## Manual RC tag after gate success
```bash
git fetch --prune origin
git switch work/main
git pull --rebase origin work/main

git tag -a rc/m6-20260305.1 -m "M6 RC gate passed"
git push origin rc/m6-20260305.1
```

## Rollback drill (rehearsal)
Use previous stable commit as rollback target:
```bash
PREV="$(git rev-parse HEAD~1)"
echo "$PREV"

git switch --detach "$PREV"
pnpm --filter @frame2/api prisma:generate
pnpm db:push
pnpm db:seed
pnpm test:smoke:m3

git switch work/main
```

## Mirror governance verification
```bash
git fetch --prune origin upstream
test "$(git rev-parse origin/main)" = "$(git rev-parse upstream/main)"
```

## RC record template
Record each RC in this section after gate succeeds:

- RC tag:
- Commit SHA:
- Workflow run URL:
- Evidence artifact name:
- OpenAI canary status:
- Rollback rehearsal result:
- Mirror governance result:

