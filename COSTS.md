# HQPixels Infrastructure Costs

This document estimates monthly infrastructure costs at various traffic levels.

_Pricing verified August 2026. Check provider websites for current rates._

## Service Summary

| Service  | Provider             | Purpose             |
| -------- | -------------------- | ------------------- |
| Compute  | Cloudflare Workers   | API and edge logic  |
| Database | Supabase             | PostgreSQL + Auth   |
| Payments | Stripe               | Payment processing  |
| Domain   | Spaceship            | Domain registration |
| Email    | Spacemail            | Transactional email |
| CAPTCHA  | Cloudflare Turnstile | Bot protection      |
| Images   | Cloudflare Images    | Image hosting       |

---

## Cloudflare Workers

### Free Tier

- 100,000 requests/day
- 10ms CPU time/request
- Free KV (limited)
- Free Durable Objects (limited)

### Workers Paid ($5/month base)

| Resource    | Included     | Overage             |
| ----------- | ------------ | ------------------- |
| Requests    | 10M/month    | $0.30/million       |
| CPU time    | 30M ms/month | $0.02/million ms    |
| KV reads    | 10M/month    | $0.50/million       |
| KV writes   | 1M/month     | $5.00/million       |
| KV storage  | 1GB          | $0.50/GB            |
| DO requests | 1M/month     | $0.15/million       |
| DO duration | 400K GB-s    | $12.50/million GB-s |

### Estimated Monthly Costs

| Traffic Level     | Requests | KV Reads | Estimated Cost |
| ----------------- | -------- | -------- | -------------- |
| Low (10K/day)     | 300K     | ~300K    | $5 (base)      |
| Medium (100K/day) | 3M       | ~3M      | $5 (base)      |
| High (1M/day)     | 30M      | ~10M     | $11            |
| Viral (10M/day)   | 300M     | ~50M     | $120           |

---

## Supabase

### Free Tier

- 500MB database
- 2GB bandwidth
- 50,000 monthly active users
- 1GB storage
- Shared compute

### Pro Plan ($25/month)

| Resource  | Included               | Overage      |
| --------- | ---------------------- | ------------ |
| Database  | 8GB                    | $0.125/GB    |
| Bandwidth | 250GB                  | $0.09/GB     |
| MAUs      | 100,000                | $0.00325/MAU |
| Storage   | 100GB                  | $0.021/GB    |
| Compute   | Dedicated 2-core       | -            |
| Backups   | Daily, 7-day retention | -            |
| PITR      | 7 days                 | -            |

### Estimated Monthly Costs

| Traffic Level | Database | MAUs  | Estimated Cost |
| ------------- | -------- | ----- | -------------- |
| Low           | <1GB     | <1K   | $25 (base)     |
| Medium        | ~2GB     | ~5K   | $25 (base)     |
| High          | ~5GB     | ~20K  | $25 (base)     |
| Scale         | ~20GB    | ~100K | $50+           |

---

## Stripe Fees

### Processing Fees

| Region              | Fee          |
| ------------------- | ------------ |
| US                  | 2.9% + $0.30 |
| International       | 3.9% + $0.30 |
| Currency conversion | +1%          |

### Example Costs

| Transaction | Fee            |
| ----------- | -------------- |
| $10 US      | $0.59 (5.9%)   |
| $50 US      | $1.75 (3.5%)   |
| $100 US     | $3.20 (3.2%)   |
| $500 US     | $14.80 (2.96%) |

### Monthly Revenue Impact

| Revenue | Stripe Fees | Net     |
| ------- | ----------- | ------- |
| $1,000  | ~$59        | $941    |
| $5,000  | ~$195       | $4,805  |
| $10,000 | ~$350       | $9,650  |
| $50,000 | ~$1,550     | $48,450 |

_Assumes average $50 transaction size, US cards only_

---

## Domain & Email

### Spaceship Domain

| Item                | Cost      |
| ------------------- | --------- |
| `.com` registration | ~$10/year |
| `.com` renewal      | ~$15/year |
| Privacy protection  | Included  |

### Spacemail

| Plan     | Cost     | Features          |
| -------- | -------- | ----------------- |
| Basic    | $2/month | 1 mailbox, 5GB    |
| Business | $4/month | 5 mailboxes, 25GB |

Estimated: **$15-50/year**

---

## Cloudflare Turnstile

**Free** for all usage levels.

- Unlimited verifications
- No cost for managed or invisible widgets

---

## Cloudflare Images

### Pricing

| Resource | Cost                           |
| -------- | ------------------------------ |
| Storage  | $5/100K images/month           |
| Delivery | $1/100K unique transformations |

### Estimated Costs

| Active Placements | Storage | Delivery    | Cost |
| ----------------- | ------- | ----------- | ---- |
| 100               | <100K   | ~10K/month  | $5   |
| 1,000             | <100K   | ~100K/month | $6   |
| 5,000             | <100K   | ~500K/month | $10  |

---

## Cost Scenarios

### Scenario 1: Launch (Month 1-3)

| Service            | Monthly Cost  |
| ------------------ | ------------- |
| Cloudflare Workers | $5            |
| Supabase Pro       | $25           |
| Cloudflare Images  | $5            |
| Domain + Email     | $3            |
| **Total**          | **$38/month** |

_Assumes <100K requests/day, <1K users, <100 placements_

### Scenario 2: Growth (Month 4-12)

| Service            | Monthly Cost  |
| ------------------ | ------------- |
| Cloudflare Workers | $10           |
| Supabase Pro       | $25           |
| Cloudflare Images  | $10           |
| Domain + Email     | $3            |
| **Total**          | **$48/month** |

_Assumes ~500K requests/day, ~10K users, ~500 placements_

### Scenario 3: Scale (Year 2+)

| Service            | Monthly Cost   |
| ------------------ | -------------- |
| Cloudflare Workers | $50            |
| Supabase Pro       | $50            |
| Cloudflare Images  | $25            |
| Domain + Email     | $5             |
| **Total**          | **$130/month** |

_Assumes ~2M requests/day, ~50K users, ~2K placements_

### Scenario 4: Viral Spike

| Service                 | Monthly Cost   |
| ----------------------- | -------------- |
| Cloudflare Workers      | $150           |
| Supabase Pro + overages | $100           |
| Cloudflare Images       | $50            |
| Domain + Email          | $5             |
| **Total**               | **$305/month** |

_Assumes 10M+ requests/day, temporary spike_

---

## Cost Optimization Recommendations

### Caching

- Wall manifest cached in KV (reduces DB reads)
- Static assets served from Cloudflare CDN (free)
- `Cache-Control` headers reduce repeat requests

### Database Efficiency

- Indexes on frequently queried columns
- Connection pooling (Supabase manages this)
- Avoid N+1 queries in batch operations

### Image Optimization

- Cloudflare Images resizes on-demand
- WebP format reduces bandwidth
- Lazy loading reduces unnecessary requests

### Worker Efficiency

- Minimize CPU time per request
- Use streaming responses where possible
- Batch analytics writes via Durable Objects

---

## Break-Even Analysis

### Fixed Costs

| Item                    | Monthly |
| ----------------------- | ------- |
| Infrastructure (base)   | $38     |
| Infrastructure (growth) | $48-130 |

### Revenue per Cell

| Cell Price | After Stripe | Net   |
| ---------- | ------------ | ----- |
| $1         | $0.67        | $0.67 |
| $5         | $4.55        | $4.55 |
| $10        | $9.41        | $9.41 |

_Assuming $1 = 100 logical pixels (1 cell)_

### Break-Even Cells/Month

| Price/Cell | Launch   | Growth   |
| ---------- | -------- | -------- |
| $1         | 57 cells | 72 cells |
| $5         | 12 cells | 15 cells |
| $10        | 6 cells  | 8 cells  |

---

## Pricing References

_Verify current pricing before deployment:_

- Cloudflare Workers: https://developers.cloudflare.com/workers/platform/pricing
- Supabase: https://supabase.com/pricing
- Stripe: https://stripe.com/pricing
- Cloudflare Images: https://developers.cloudflare.com/images/pricing
- Spaceship: https://www.spaceship.com/pricing

---

## Budget Alerts

Recommended spending alerts:

| Service    | Alert At   | Action                  |
| ---------- | ---------- | ----------------------- |
| Cloudflare | $50/month  | Review traffic patterns |
| Supabase   | $50/month  | Consider optimization   |
| Stripe     | n/a        | Monitor dispute rate    |
| Total      | $100/month | Review growth plan      |
