# HQPixels Deployment Guide

This guide covers deploying HQPixels to production with Cloudflare Workers, Supabase, and Stripe.

## Prerequisites

- Cloudflare account (Workers paid plan recommended)
- Supabase account (Pro plan for production)
- Stripe account (activated for live payments)
- Domain registered (we use Spaceship)
- Wrangler CLI installed (`npm install -g wrangler`)

## 1. Domain & DNS Setup

### 1.1 Register Domain (Spaceship)

1. Register `hqpixels.com` at [spaceship.com](https://spaceship.com)
2. Do NOT use Spaceship's nameservers — we'll point to Cloudflare

### 1.2 Add Domain to Cloudflare

1. Log into Cloudflare Dashboard
2. Click "Add a Site" → enter `hqpixels.com`
3. Select plan (Free is sufficient for DNS)
4. Cloudflare will scan existing DNS records
5. Copy the assigned nameservers (e.g., `ns1.cloudflare.com`, `ns2.cloudflare.com`)

### 1.3 Update Nameservers at Spaceship

1. Go to Spaceship Domain Manager → `hqpixels.com` → DNS Settings
2. Select "Custom DNS" and enter Cloudflare nameservers
3. Wait for propagation (up to 24 hours, usually faster)
4. Cloudflare will show "Active" when complete

### 1.4 Configure DNS Records

In Cloudflare DNS:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | `@` | `hqpixels.workers.dev` | Proxied |
| CNAME | `www` | `hqpixels.com` | Proxied |

For email (Spacemail):

| Type | Name | Content | Priority |
|------|------|---------|----------|
| MX | `@` | `mx1.spaceship.com` | 10 |
| MX | `@` | `mx2.spaceship.com` | 20 |
| TXT | `@` | `v=spf1 include:spf.spaceship.com ~all` | - |

### 1.5 Enable DNSSEC

1. In Cloudflare → DNS → DNSSEC → Enable
2. Copy the DS record details
3. In Spaceship → Domain Settings → DNSSEC
4. Add DS record with values from Cloudflare
5. Wait for propagation and verify

---

## 2. Supabase Setup

### 2.1 Create Project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Name: `hqpixels-production`
3. Region: Choose closest to target users
4. Generate and securely store the database password

### 2.2 Apply Migrations

```bash
# Install Supabase CLI
npm install -g supabase

# Login
supabase login

# Link to project
supabase link --project-ref <project-id>

# Push migrations
supabase db push
```

### 2.3 Get Connection Details

From Project Settings → API:

- `SUPABASE_URL`: `https://<project-id>.supabase.co`
- `SUPABASE_ANON_KEY`: Public anon key
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key (keep secret!)

### 2.4 Configure Auth

In Authentication → Settings:

1. **Site URL**: `https://hqpixels.com`
2. **Redirect URLs**: Add:
   - `https://hqpixels.com/auth/callback`
   - `https://hqpixels.com/dashboard`
3. **Email**: Configure SMTP (see §5)
4. **Providers**: Enable Google OAuth if desired

---

## 3. Cloudflare Workers Setup

### 3.1 Authenticate Wrangler

```bash
wrangler login
```

### 3.2 Create KV Namespaces

```bash
# Production
wrangler kv:namespace create CACHE_KV
wrangler kv:namespace create RATE_KV

# Note the IDs returned, e.g.:
# { binding = "CACHE_KV", id = "abc123..." }
```

### 3.3 Update wrangler.jsonc

Replace placeholder IDs:

```jsonc
"kv_namespaces": [
  {
    "binding": "CACHE_KV",
    "id": "<production-cache-kv-id>",
    "preview_id": "<preview-cache-kv-id>"
  },
  {
    "binding": "RATE_KV",
    "id": "<production-rate-kv-id>",
    "preview_id": "<preview-rate-kv-id>"
  }
]
```

### 3.4 Configure Secrets

```bash
# Supabase
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Stripe
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put STRIPE_PRICE_ID

# Turnstile
wrangler secret put TURNSTILE_SECRET_KEY

# Security
wrangler secret put CSRF_SECRET
wrangler secret put COOKIE_SECRET
wrangler secret put ADMIN_EMAIL_ALLOWLIST
```

Generate secure secrets:
```bash
# Generate 32-byte random secret
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 3.5 Deploy

```bash
# Staging
pnpm deploy:staging

# Production
pnpm deploy:production
```

### 3.6 Configure Custom Domain

1. In Cloudflare Dashboard → Workers → hqpixels
2. Settings → Triggers → Custom Domains
3. Add `hqpixels.com`
4. Cloudflare will configure the route automatically

---

## 4. Stripe Setup

See [STRIPE_SETUP.md](STRIPE_SETUP.md) for detailed Stripe configuration.

Quick steps:
1. Create Stripe account and activate for live payments
2. Create webhook endpoint: `https://hqpixels.com/api/stripe/webhook`
3. Subscribe to events: `checkout.session.completed`, `checkout.session.expired`, etc.
4. Note the webhook signing secret

---

## 5. Email Setup (Spacemail)

### 5.1 Configure Spacemail

1. In Spaceship → Email → Create mailbox for `hqpixels.com`
2. Create addresses:
   - `noreply@hqpixels.com` (transactional)
   - `support@hqpixels.com` (support)
   - `security@hqpixels.com` (security reports)

### 5.2 Configure Supabase SMTP

In Supabase → Project Settings → Auth → SMTP:

| Setting | Value |
|---------|-------|
| Host | `smtp.spaceship.com` |
| Port | 587 |
| User | `noreply@hqpixels.com` |
| Password | (mailbox password) |
| Sender email | `noreply@hqpixels.com` |
| Sender name | `HQPixels` |

### 5.3 Email Templates

Customize templates in Authentication → Email Templates:
- Confirm signup
- Magic link
- Change email
- Reset password

---

## 6. Cloudflare Images

### 6.1 Enable Cloudflare Images

1. Cloudflare Dashboard → Images → Enable
2. Note the Account ID and Images account hash

### 6.2 Configure API Token

Create token with Images permissions:
1. Profile → API Tokens → Create Token
2. Permissions: `Cloudflare Images: Edit`

```bash
wrangler secret put CLOUDFLARE_IMAGES_TOKEN
wrangler secret put CLOUDFLARE_IMAGES_ACCOUNT_ID
```

### 6.3 Update Config

Set in wrangler.jsonc vars:
```jsonc
"vars": {
  "CLOUDFLARE_IMAGES_DELIVERY_BASE": "https://imagedelivery.net/<account-hash>"
}
```

---

## 7. Turnstile Setup

### 7.1 Create Turnstile Widget

1. Cloudflare Dashboard → Turnstile → Add Site
2. Site name: `hqpixels.com`
3. Domains: `hqpixels.com`, `localhost` (for development)
4. Widget type: Managed
5. Note Site Key and Secret Key

### 7.2 Configure

Client (`.env`):
```
VITE_TURNSTILE_SITE_KEY=0x4AAA...
```

Server:
```bash
wrangler secret put TURNSTILE_SECRET_KEY
```

---

## 8. SSL/TLS Configuration

### 8.1 Cloudflare SSL Settings

In Cloudflare → SSL/TLS:

| Setting | Value |
|---------|-------|
| SSL/TLS encryption mode | Full (strict) |
| Always Use HTTPS | On |
| Automatic HTTPS Rewrites | On |
| TLS 1.3 | On |
| Minimum TLS Version | 1.2 |

### 8.2 Enable HSTS

After confirming HTTPS works:

1. In Cloudflare → SSL/TLS → Edge Certificates
2. Enable HSTS with:
   - Max-Age: 31536000 (1 year)
   - Include subdomains: Yes
   - Preload: Yes (submit to hstspreload.org)

### 8.3 CAA Records

Add CAA records to restrict certificate issuance:

| Type | Name | Content |
|------|------|---------|
| CAA | `@` | `0 issue "digicert.com"` |
| CAA | `@` | `0 issue "letsencrypt.org"` |
| CAA | `@` | `0 issuewild ";"` |

---

## 9. Post-Deployment Verification

### 9.1 Health Check

```bash
curl https://hqpixels.com/api/health
# Should return: {"ok":true,"environment":"production"}
```

### 9.2 Security Headers

```bash
curl -I https://hqpixels.com | grep -E "(Content-Security|X-Frame|Strict-Transport)"
```

Expected:
```
Content-Security-Policy: default-src 'none'; ...
X-Frame-Options: DENY
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

### 9.3 DNSSEC

```bash
dig +dnssec hqpixels.com
# Should show RRSIG records
```

### 9.4 Full Test

1. Visit https://hqpixels.com
2. Sign up with email
3. Reserve cells
4. Complete test payment (use Stripe test mode first!)
5. Verify placement appears after moderation

---

## 10. Environment Variable Reference

### Worker Secrets (wrangler secret)

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Stripe price ID (if using fixed pricing) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret |
| `CSRF_SECRET` | CSRF token signing secret |
| `COOKIE_SECRET` | Cookie signing secret |
| `ADMIN_EMAIL_ALLOWLIST` | Comma-separated admin emails |
| `CLOUDFLARE_IMAGES_TOKEN` | Cloudflare Images API token |
| `CLOUDFLARE_IMAGES_ACCOUNT_ID` | Cloudflare account ID |

### Client Environment (.env)

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |

---

## 11. Rollback Procedure

If deployment fails:

```bash
# List recent deployments
wrangler deployments list

# Rollback to previous version
wrangler rollback

# Or rollback to specific deployment
wrangler rollback <deployment-id>
```

---

## 12. Monitoring

### Cloudflare Analytics

- Workers → Analytics for request/error rates
- Web Analytics for page views (add snippet if desired)

### Supabase Dashboard

- Database → Reports for query performance
- Auth → Users for authentication metrics

### Stripe Dashboard

- Payments → Monitor payment success rate
- Webhooks → Check delivery status

---

## Checklist

- [ ] Domain registered and nameservers pointed to Cloudflare
- [ ] DNS records configured (CNAME, MX, SPF, DKIM)
- [ ] DNSSEC enabled and DS record added
- [ ] Supabase project created and migrations applied
- [ ] KV namespaces created and IDs updated
- [ ] All secrets configured via `wrangler secret`
- [ ] Cloudflare Images enabled and configured
- [ ] Turnstile widget created
- [ ] SSL/TLS set to Full (strict)
- [ ] HSTS enabled (after verification)
- [ ] CAA records added
- [ ] Stripe webhook configured (see STRIPE_SETUP.md)
- [ ] Email (Spacemail) configured in Supabase
- [ ] Health check returns OK
- [ ] Test purchase completed
