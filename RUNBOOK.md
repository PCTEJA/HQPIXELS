# HQPixels Operations Runbook

This document contains operational procedures for running HQPixels in production.

## Table of Contents

1. [Incident Response](#incident-response)
2. [Key Rotation](#key-rotation)
3. [Deployment Rollback](#deployment-rollback)
4. [Refund Handling](#refund-handling)
5. [Dispute Handling](#dispute-handling)
6. [Abuse Takedown](#abuse-takedown)
7. [Database Backup & Restore](#database-backup--restore)
8. [Monitoring & Alerts](#monitoring--alerts)

---

## 1. Incident Response

### Severity Levels

| Level | Description               | Response Time | Example                               |
| ----- | ------------------------- | ------------- | ------------------------------------- |
| P0    | Service down, data breach | 15 min        | Workers returning 500, DB unreachable |
| P1    | Major feature broken      | 1 hour        | Payments failing, auth broken         |
| P2    | Minor feature degraded    | 4 hours       | Slow queries, rate limit issues       |
| P3    | Cosmetic/low impact       | 24 hours      | UI glitch, missing analytics          |

### Incident Response Steps

#### 1. Assess and Communicate

```
1. Determine severity level
2. Post to #incidents channel (if applicable)
3. Update status page (if applicable)
```

#### 2. Investigate

```bash
# Check Worker logs
wrangler tail --env production

# Check Supabase logs
# Dashboard → Database → Logs

# Check Stripe webhook delivery
# Dashboard → Developers → Webhooks → Logs
```

#### 3. Mitigate

For Worker issues:

```bash
# Rollback to previous deployment
wrangler rollback --env production
```

For database issues:

```bash
# Contact Supabase support for Pro plans
# Or restore from point-in-time backup
```

#### 4. Resolve and Document

```
1. Apply permanent fix
2. Deploy fix
3. Verify resolution
4. Write post-mortem (for P0/P1)
```

### Post-Mortem Template

```markdown
## Incident: [Title]

**Date:** YYYY-MM-DD
**Duration:** X hours
**Severity:** P0/P1/P2/P3

### Summary

Brief description of what happened.

### Timeline

- HH:MM - Issue detected
- HH:MM - Investigation started
- HH:MM - Root cause identified
- HH:MM - Mitigation applied
- HH:MM - Resolved

### Root Cause

What caused the incident.

### Impact

- Users affected: X
- Revenue impact: $X
- Data loss: Yes/No

### Action Items

- [ ] Task 1
- [ ] Task 2
```

---

## 2. Key Rotation

### Stripe Keys

**When to rotate:** Suspected compromise, scheduled rotation (quarterly recommended)

```bash
# 1. Generate new keys in Stripe Dashboard
# Dashboard → Developers → API Keys → Roll key

# 2. Update Worker secret
wrangler secret put STRIPE_SECRET_KEY --env production
# Enter new sk_live_... key

# 3. If webhook secret compromised:
# Dashboard → Webhooks → (endpoint) → Roll secret
wrangler secret put STRIPE_WEBHOOK_SECRET --env production

# 4. Verify payments still work
curl -X POST https://hqpixels.com/api/health

# 5. Old key automatically expires (Stripe handles this)
```

### Supabase Keys

**When to rotate:** Suspected compromise, personnel change

```bash
# 1. Generate new keys in Supabase Dashboard
# Settings → API → Generate new keys

# 2. Update Worker secrets
wrangler secret put SUPABASE_ANON_KEY --env production
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production

# 3. Update client .env (requires rebuild and deploy)
VITE_SUPABASE_ANON_KEY=new_key

# 4. Deploy updated client
pnpm build
pnpm deploy:production

# 5. Verify auth still works
```

### CSRF/Cookie Secrets

**When to rotate:** Suspected compromise

```bash
# Generate new secret
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# Update secrets
wrangler secret put CSRF_SECRET --env production
wrangler secret put COOKIE_SECRET --env production

# Note: This will invalidate all existing sessions
# Users will need to log in again
```

### Turnstile Keys

```bash
# 1. Generate new keys in Cloudflare Dashboard
# Turnstile → (site) → Rotate keys

# 2. Update client and server
# .env: VITE_TURNSTILE_SITE_KEY=new_key
wrangler secret put TURNSTILE_SECRET_KEY --env production

# 3. Deploy
pnpm build
pnpm deploy:production
```

---

## 3. Deployment Rollback

### Quick Rollback

```bash
# List recent deployments
wrangler deployments list --env production

# Rollback to previous version
wrangler rollback --env production

# Or specify deployment ID
wrangler rollback <deployment-id> --env production
```

### Database Migration Rollback

**Warning:** Database rollbacks can cause data loss. Always backup first.

```bash
# Check current migration version
supabase db remote changes

# Manual rollback (create down migration)
supabase migration create rollback_<feature>

# Apply rollback
supabase db push
```

### Full Rollback Procedure

1. **Assess impact of current deployment**
2. **Rollback Worker:**
   ```bash
   wrangler rollback --env production
   ```
3. **If DB migration was part of release:**
   - Evaluate if rollback is needed
   - Create and test rollback migration
   - Apply in transaction if possible
4. **Verify functionality**
5. **Communicate status**

---

## 4. Refund Handling

### Standard Refund

```bash
# Via Stripe Dashboard (preferred)
# Payments → Find payment → Refund

# Via Stripe CLI
stripe refunds create --payment-intent <pi_xxx>
```

### Refund Webhook Handling

When `charge.refunded` is received:

1. Database marks placement as `disabled`
2. Cells are released back to pool
3. Audit log records the refund

### Partial Refund

Currently not supported. Full refund only.

### Refund Policy (documented in Terms):

- Within 24 hours of purchase: Full refund, no questions
- After placement approved: Refund only for policy violation
- After 30 days: No refund

---

## 5. Dispute Handling

### When Dispute Received

1. **Webhook receives `charge.dispute.created`**
2. **Automatic actions:**
   - Placement disabled immediately
   - Audit log entry created
   - (Optional) Admin notification sent

### Manual Response (within 7 days)

```
1. Log into Stripe Dashboard
2. Navigate to Payments → Disputes
3. Gather evidence:
   - Screenshot of purchased placement
   - IP address and user agent from audit log
   - Email confirmation sent to user
   - Terms of service acceptance timestamp
4. Submit evidence via Dashboard
```

### Evidence Template

```
Customer purchased [X cells] on HQPixels.com on [date].

Evidence of legitimate purchase:
1. IP address: [from audit log]
2. Account email verified: [timestamp]
3. Terms accepted: [timestamp]
4. Image uploaded by customer: [screenshot]
5. Placement was live at: [URL]

The customer received the digital goods as described.
```

### Dispute Resolution

When `charge.dispute.closed` received:

- If won: Placement can be re-enabled (manual decision)
- If lost: Placement remains disabled, cells released

---

## 6. Abuse Takedown

### Identifying Abuse

**Automatic detection:**

- Link health checks (daily)
- Content review queue

**Manual reports:**

- Contact form submissions
- Email to abuse@hqpixels.com

### Takedown Procedure

#### 1. Assess

```sql
-- Find placement details
SELECT p.*, r.owner_id, pr.email
FROM placements p
JOIN reservations r ON p.reservation_id = r.id
JOIN profiles pr ON r.owner_id = pr.id
WHERE p.id = '<placement-id>';
```

#### 2. Disable (immediate for clear violations)

```bash
# Via Admin UI
# /admin → Moderation Queue → Find placement → Disable

# This records in moderation_actions and audit_log
```

#### 3. Bulk Disable by Host (for domain-wide abuse)

```bash
# Via Admin UI
# /admin → Bulk Disable → Enter host → Confirm
```

#### 4. Document

```
Reason: [copyright, malware, scam, etc.]
Evidence: [screenshot, URL, report]
Action: Disabled on [date] by [admin]
```

#### 5. Notify User (optional, depends on violation type)

Email template:

```
Your placement on HQPixels has been disabled for violating our Terms of Service.

Reason: [specific violation]

If you believe this is in error, reply to this email.
```

### DMCA Takedown

For copyright claims:

1. Verify claim is from rights holder
2. Disable placement immediately
3. Notify placement owner with counter-notice rights
4. Document in audit log
5. Respond to claimant within 24 hours

---

## 7. Database Backup & Restore

### Supabase Automatic Backups

Supabase Pro includes:

- Daily backups (retained 7 days)
- Point-in-time recovery (up to 7 days)

### Manual Backup

```bash
# Using pg_dump (requires connection string)
pg_dump "$SUPABASE_DB_URL" > backup_$(date +%Y%m%d).sql

# Verify backup
head -50 backup_*.sql
```

### Point-in-Time Restore

1. Go to Supabase Dashboard
2. Database → Backups
3. Select point in time
4. Restore to new database (recommended) or overwrite

**Warning:** Restoring overwrites all data since that point.

### Restore Drill (quarterly recommended)

```
1. Create test project in Supabase
2. Restore backup to test project
3. Verify:
   - Tables exist with expected schema
   - Sample data queries return results
   - RPC functions work
4. Document results
5. Delete test project
```

### Restore Verification Checklist

- [ ] All 17 tables present
- [ ] Row counts match expected
- [ ] Sample user can authenticate
- [ ] Sample reservation has correct cells
- [ ] RLS policies enforced
- [ ] Admin functions work

---

## 8. Monitoring & Alerts

### Cloudflare Workers

**Dashboard:** Workers → Analytics

Key metrics:

- Request count
- Error rate (should be <1%)
- P99 latency (should be <200ms for cached endpoints)

### Supabase

**Dashboard:** Project → Database → Reports

Key metrics:

- Query execution time
- Connection pool usage
- Storage usage

### Stripe

**Dashboard:** Home → Overview

Key metrics:

- Payment success rate (should be >95%)
- Webhook delivery success
- Dispute rate (should be <0.5%)

### Manual Health Check

```bash
# API health
curl https://hqpixels.com/api/health
# Expected: {"ok":true,"environment":"production"}

# Database connectivity
curl https://hqpixels.com/api/public/stats
# Expected: JSON with stats

# SSL certificate
openssl s_client -connect hqpixels.com:443 -servername hqpixels.com 2>/dev/null | openssl x509 -noout -dates
# Check expiry date
```

### Alert Configuration

Recommended alerts (via Stripe/Cloudflare dashboards or external monitoring):

| Alert                     | Threshold       | Priority |
| ------------------------- | --------------- | -------- |
| Worker error rate         | >5% for 5 min   | P1       |
| Payment success rate      | <90% for 15 min | P1       |
| Webhook delivery failures | >10 in 1 hour   | P2       |
| New disputes              | Any             | P2       |
| Database CPU              | >80% sustained  | P2       |

### On-Call Checklist

Daily:

- [ ] Check Worker error rate
- [ ] Check payment success rate
- [ ] Review moderation queue

Weekly:

- [ ] Check webhook delivery success
- [ ] Review audit log for anomalies
- [ ] Check disk/storage usage

Monthly:

- [ ] Review dispute rate
- [ ] Check certificate expiry
- [ ] Test restore procedure
