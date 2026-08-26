# HQPixels Product Requirements Document

## Executive Summary

HQPixels is an interactive pixel-ad marketplace where users purchase rectangular regions on a 1000×1000 logical-pixel wall, upload images, and link to destinations. It combines the nostalgic appeal of early internet advertising with modern payment processing, content moderation, and analytics.

---

## Vision

Create a transparent, honest advertising platform where businesses and individuals can secure permanent digital real estate on a finite canvas, with clear pricing and no hidden fees.

---

## Target Users

### Primary: Small Business Owners

- Looking for affordable, permanent advertising
- Value simplicity over complex ad targeting
- Appreciate transparency in pricing

### Secondary: Content Creators

- YouTubers, streamers, bloggers
- Want to promote their channels/content
- Budget-conscious marketing

### Tertiary: Collectors/Enthusiasts

- Internet nostalgia enthusiasts
- Want to "own" a piece of internet history
- May purchase for fun rather than ROI

---

## Core Features

### 1. Interactive Pixel Wall

**Description:** A canvas displaying all purchased placements with pan, zoom, hover preview, and click-through.

**User Stories:**
- As a visitor, I can pan and zoom the wall to explore placements
- As a visitor, I can hover over a placement to see a preview tooltip
- As a visitor, I can click a placement to visit the destination

**Requirements:**
| Requirement | Specification |
|-------------|---------------|
| Wall size | 1000×1000 logical pixels |
| Cell size | 10×10 logical pixels (100 pixels/cell) |
| Total cells | 10,000 |
| Min selection | 1 cell (10×10 pixels) |
| Max selection | 50×50 cells (2,500 cells, 250,000 pixels) |
| Performance | 60fps pan/zoom on modern devices |
| Accessibility | Keyboard navigable, screen reader support |

### 2. Claim Flow

**Description:** The process of selecting, paying for, and uploading an image for a cell region.

**User Stories:**
- As a buyer, I can select an available region on the wall
- As a buyer, I can see a real-time price quote as I adjust my selection
- As a buyer, I can complete payment via Stripe Checkout
- As a buyer, I can upload an image and set a destination URL

**Flow:**
1. User selects cells on wall → Preview quote
2. User authenticates (if needed)
3. User confirms selection → Cells reserved (45 min hold)
4. User completes Stripe Checkout
5. User uploads image and sets destination URL
6. Placement enters moderation queue
7. Admin approves → Placement goes live

**Requirements:**
| Requirement | Specification |
|-------------|---------------|
| Reservation TTL | 45 minutes |
| Image formats | PNG, JPEG, WebP, GIF |
| Max image size | 2MB |
| URL validation | HTTPS preferred, no malware domains |

### 3. Dynamic Pricing

**Description:** Price varies by location (zones) with optional volume considerations.

**Pricing Model:**
| Zone | Description | Multiplier |
|------|-------------|------------|
| Center | 40×40 center region | 1.5× (15,000 bp) |
| Standard | Remainder | 1.0× (10,000 bp) |

**Base rate:** Configurable per pricing version (e.g., $0.10/pixel = $10/cell)

**Example:**
- 10×10 cells in standard zone: 100 cells × 100 px × $0.10 = $1,000
- 10×10 cells in center zone: 100 cells × 100 px × $0.10 × 1.5 = $1,500

### 4. User Dashboard

**Description:** Authenticated users can view and manage their placements.

**User Stories:**
- As a buyer, I can see all my placements and their status
- As a buyer, I can view analytics (views, clicks) for my placements
- As a buyer, I can edit my destination URL (within limits)
- As a buyer, I can see payment history

**Requirements:**
| Requirement | Specification |
|-------------|---------------|
| Analytics | Views, clicks, CTR |
| Update limits | URL editable, image not editable |
| History | All payments and status changes |

### 5. Admin Moderation

**Description:** Admin interface for reviewing and approving placements.

**User Stories:**
- As an admin, I can see pending placements in a queue
- As an admin, I can approve or reject placements with a reason
- As an admin, I can disable placements that violate ToS
- As an admin, I can bulk-disable placements from a malicious domain

**Requirements:**
| Requirement | Specification |
|-------------|---------------|
| Queue | Sorted by submission time |
| Actions | Approve, Reject, Disable, Re-enable |
| Audit | All actions logged with actor and reason |

### 6. Analytics & Leaderboards

**Description:** Public statistics and rankings.

**User Stories:**
- As a visitor, I can see aggregate statistics (total sold, views, clicks)
- As a visitor, I can see top placements by views/clicks
- As a buyer, I can see where my placement ranks

**Requirements:**
| Requirement | Specification |
|-------------|---------------|
| Stats | Total cells sold, total views, total clicks |
| Leaderboard | Top 100 by views, clicks |
| Update frequency | Hourly snapshots |

---

## Non-Functional Requirements

### Performance

| Metric | Target |
|--------|--------|
| First Contentful Paint | <1.5s |
| Time to Interactive | <3s |
| Wall render (10k placements) | <500ms |
| API response (cached) | <150ms p95 |
| API response (uncached) | <500ms p95 |

### Security

| Requirement | Implementation |
|-------------|----------------|
| Authentication | Supabase Auth with PKCE |
| Authorization | Row-Level Security |
| Payment integrity | Price computed server-side only |
| CSRF protection | Double-submit cookie pattern |
| Rate limiting | Per-IP and per-user limits |

### Accessibility

| Standard | Compliance |
|----------|------------|
| WCAG 2.1 | AA level |
| Keyboard | Full navigation support |
| Screen readers | ARIA labels, live regions |
| Reduced motion | Respects user preference |

### Availability

| Metric | Target |
|--------|--------|
| Uptime | 99.9% |
| RTO | 4 hours |
| RPO | 24 hours |

---

## Content Policy

### Prohibited Content

1. **Illegal content** — Anything illegal under US law
2. **Malware/phishing** — Links to malicious sites
3. **Adult content** — Pornography, explicit material
4. **Hate speech** — Discrimination, harassment
5. **Scams** — Fraudulent offers, deceptive practices
6. **Copyright infringement** — Unauthorized use of IP

### Moderation Process

1. All placements require approval before going live
2. Automated checks for known malware domains
3. Manual review by admin
4. Appeal process via email

---

## Honest Marketing Requirements

**Non-negotiable:** No fake data, ever.

| Prohibited | Required |
|------------|----------|
| Fake testimonials | Real user feedback (or none) |
| Fake view counts | Actual metrics (or "no data yet") |
| Fake scarcity ("only 3 left!") | Actual availability |
| Pre-checked consent boxes | Explicit opt-in |
| "Visitors" label on pageviews | "Total page views" label |
| Fabricated urgency | Honest timelines |

---

## Success Metrics

### Launch (Month 1)

- [ ] 100 cells sold
- [ ] <5% checkout abandonment
- [ ] Zero security incidents
- [ ] <24h moderation turnaround

### Growth (Month 3)

- [ ] 1,000 cells sold
- [ ] 10,000 monthly active visitors
- [ ] <1% dispute rate
- [ ] 4.0+ user satisfaction

### Scale (Year 1)

- [ ] 5,000 cells sold (50% capacity)
- [ ] 100,000 monthly active visitors
- [ ] Positive unit economics
- [ ] Self-sustaining moderation

---

## Roadmap

### Phase 1: MVP (Complete)

- [x] Interactive pixel wall
- [x] Claim flow with Stripe
- [x] User authentication
- [x] Basic admin moderation
- [x] Core analytics

### Phase 2: Polish (Complete)

- [x] Enhanced analytics
- [x] Leaderboards
- [x] Bulk admin actions
- [x] Comprehensive testing

### Phase 3: Launch (Current)

- [x] Production deployment
- [x] Documentation
- [ ] Beta users
- [ ] Public launch

### Phase 4: Growth (Future)

- [ ] Email notifications
- [ ] Social sharing
- [ ] API for integrations
- [ ] Mobile app consideration

### Phase 5: Scale (Future)

- [ ] Multiple walls/themes
- [ ] Subscription options
- [ ] Advanced analytics
- [ ] Partner program

---

## Technical Decisions

### Why Cloudflare Workers?

- Global edge deployment
- Sub-millisecond cold starts
- Integrated KV and Durable Objects
- Native Stripe/Turnstile integration
- Cost-effective at scale

### Why Supabase?

- PostgreSQL with RLS
- Built-in authentication
- Real-time subscriptions (if needed)
- Managed backups and scaling

### Why PixiJS?

- WebGL performance for canvas
- Well-maintained, large community
- Smooth pan/zoom interactions
- Good accessibility primitives

### Why Not...

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| Custom auth | Time, security risk |
| Self-hosted DB | Ops overhead |
| Canvas 2D | Performance at scale |
| SSR | Complexity, edge constraints |

---

## Glossary

| Term | Definition |
|------|------------|
| Cell | A 10×10 logical pixel purchasable unit |
| Placement | A paid, approved image on the wall |
| Reservation | A hold on cells before payment |
| Logical pixel | 1×1 coordinate unit on the 1000×1000 wall |
| Zone | A region with a price multiplier |
| BP (Basis Points) | 1/100th of a percent (10,000 bp = 100%) |
