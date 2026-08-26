# Branch Protection Settings

Configure these settings for the `main` branch in GitHub repository settings:
**Settings → Branches → Add branch protection rule**

## Branch name pattern

```
main
```

## Protection rules

### Require a pull request before merging

- [x] **Require approvals**: 1
- [x] **Dismiss stale pull request approvals when new commits are pushed**
- [ ] Require review from Code Owners
- [x] **Require approval of the most recent reviewable push**

### Require status checks to pass before merging

- [x] **Require status checks to pass before merging**
- [x] **Require branches to be up to date before merging**

#### Required status checks

Add these checks (they come from the `ci.yml` workflow):

| Check Name       | Description                   |
| ---------------- | ----------------------------- |
| `Lint & Format`  | Prettier + ESLint             |
| `TypeScript`     | All 3 tsconfig files          |
| `Unit Tests`     | Vitest test suite             |
| `Build`          | Vite build + Wrangler dry-run |
| `Security Audit` | npm audit at high level       |

Optional but recommended:

| Check Name               | Description                |
| ------------------------ | -------------------------- |
| `Database Tests (pgTAP)` | PostgreSQL schema/behavior |
| `CSP Assertion`          | No inline scripts in build |
| `Headers Drift Check`    | _headers file matches gen  |

### Require conversation resolution before merging

- [x] **Require conversation resolution before merging**

### Require signed commits

- [ ] Require signed commits _(optional, enable if team uses GPG)_

### Require linear history

- [ ] Require linear history _(optional, prevents merge commits)_

### Do not allow bypassing the above settings

- [x] **Do not allow bypassing the above settings**

### Restrict who can push to matching branches

- [ ] Restrict who can push _(optional, for admin-only deploys)_

### Rules applied to everyone including administrators

- [x] **Do not allow force pushes**
- [x] **Do not allow deletions**

---

## Additional recommendations

### Rulesets (GitHub Repository Rules)

For more granular control, consider using GitHub's newer Rulesets feature:
**Settings → Rules → Rulesets → New ruleset**

### Secret scanning

Enable in **Settings → Code security and analysis**:

- [x] **Dependency graph**
- [x] **Dependabot alerts**
- [x] **Dependabot security updates**
- [x] **Secret scanning**
- [x] **Push protection** (blocks secrets from being pushed)

### Code scanning

CodeQL is configured via `.github/workflows/codeql.yml` and will appear in:
**Security → Code scanning alerts**

---

## Verification

After configuring, verify protection is active:

```bash
# This should be rejected (direct push to main)
git push origin main  # ❌ Should fail

# This should work (via PR)
git checkout -b feature/test
git push origin feature/test
# Create PR → Get approval → Merge ✅
```
