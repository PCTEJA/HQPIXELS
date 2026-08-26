# HQPixels Architecture

This document describes the system architecture of HQPixels, an interactive pixel-ad marketplace.

## High-Level System Diagram

```mermaid
graph TB
    subgraph "Client (Browser)"
        UI[React SPA]
        Canvas[PixiJS Canvas]
        TQ[TanStack Query]
    end

    subgraph "Edge (Cloudflare)"
        CDN[CDN / Asset Layer]
        Worker[Hono Worker]
        RL[RateLimiterDO]
        AB[AnalyticsBufferDO]
        KV[(KV Cache)]
    end

    subgraph "Backend Services"
        Supabase[(Supabase PostgreSQL)]
        Stripe[Stripe API]
        Turnstile[Cloudflare Turnstile]
    end

    UI --> Canvas
    UI --> TQ
    TQ -->|API Requests| CDN
    CDN -->|Static Assets| UI
    CDN -->|/api/*, /go/*| Worker
    Worker --> RL
    Worker --> AB
    Worker --> KV
    Worker -->|RPC| Supabase
    Worker -->|Checkout/Webhooks| Stripe
    Worker -->|Verify| Turnstile
    Stripe -->|Webhooks| Worker
```

## Request Flow

### Public Page Load

```mermaid
sequenceDiagram
    participant B as Browser
    participant CDN as Cloudflare CDN
    participant W as Worker
    participant KV as KV Cache
    participant DB as Supabase

    B->>CDN: GET /
    CDN->>B: index.html (cached)
    B->>CDN: GET /assets/*.js
    CDN->>B: JS bundles (cached)
    B->>W: GET /api/wall/manifest
    W->>KV: Check cache
    alt Cache hit
        KV->>W: Manifest JSON
    else Cache miss
        W->>DB: wall_manifest()
        DB->>W: Manifest data
        W->>KV: Store (5min TTL)
    end
    W->>B: Manifest JSON
```

### Claim Flow (Purchase)

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as Worker
    participant T as Turnstile
    participant DB as Supabase
    participant S as Stripe

    B->>T: Request challenge
    T->>B: Token
    B->>W: POST /api/reservations/create
    W->>T: Verify token
    T->>W: Valid
    W->>DB: reserve_cells(x, y, w, h)
    DB->>W: reservation_id
    W->>B: 201 Created

    B->>W: POST /api/checkout/session
    W->>DB: open_checkout(reservation_id)
    DB->>W: pending payment record
    W->>S: Create Checkout Session
    S->>W: session_url
    W->>B: Redirect URL

    B->>S: Complete payment
    S->>W: Webhook: checkout.session.completed
    W->>DB: verify_stripe_event(id)
    W->>DB: settle_payment(...)
    DB->>W: Updated state
    W->>S: 200 OK
```

## Database Schema

```mermaid
erDiagram
    profiles ||--o{ reservations : owns
    profiles ||--o{ placements : owns
    profiles ||--o{ abuse_reports : submits

    reservations ||--|| pixel_cells : allocates
    reservations ||--o{ payments : has
    reservations ||--|| placements : creates

    placements ||--o{ moderation_actions : receives
    placements ||--o{ view_aggregates : tracks
    placements ||--o{ click_aggregates : tracks

    payments ||--o{ stripe_events : records

    profiles {
        uuid id PK
        text email
        boolean is_admin
        timestamptz email_verified_at
    }

    reservations {
        uuid id PK
        uuid owner_id FK
        int cell_x
        int cell_y
        int width_cells
        int height_cells
        int total_cents
        text currency
        reservation_status status
        timestamptz expires_at
    }

    pixel_cells {
        int cell_x PK
        int cell_y PK
        uuid reservation_id FK
    }

    placements {
        uuid id PK
        uuid reservation_id FK
        uuid owner_id FK
        text image_path
        text destination_url
        placement_status status
    }

    payments {
        uuid id PK
        uuid reservation_id FK
        text stripe_session_id
        payment_status status
        int amount_cents
    }

    stripe_events {
        text id PK
        text type
        jsonb payload
        timestamptz created_at
    }

    moderation_actions {
        uuid id PK
        uuid placement_id FK
        uuid actor_id FK
        moderation_action_type action
        text reason
    }

    audit_logs {
        bigint id PK
        text event_type
        uuid actor_id
        jsonb detail
        timestamptz created_at
    }
```

## Durable Objects

### RateLimiterDO

Sliding-window rate limiter using SQLite storage within Durable Objects.

```mermaid
graph LR
    subgraph "Per-IP Instance"
        DO[RateLimiterDO]
        SQL[(SQLite)]
    end

    R1[Request 1] --> DO
    R2[Request 2] --> DO
    R3[Request 3] --> DO
    DO --> SQL
    DO -->|Allow/Deny| Response
```

**Configuration:**

- 60 requests per minute for anonymous users
- 120 requests per minute for authenticated users
- 10 requests per minute for mutations (POST/PUT/DELETE)

### AnalyticsBufferDO

Batches analytics events to reduce database writes.

```mermaid
graph TB
    subgraph "Event Flow"
        E1[View Event] --> DO[AnalyticsBufferDO]
        E2[Click Event] --> DO
        E3[Impression] --> DO
        DO --> Buffer[(In-Memory Buffer)]
        Buffer -->|Flush every 30s| DB[(Supabase)]
    end
```

**Events buffered:**

- Page views (per placement)
- Link clicks (per placement)
- Impressions (viewport visibility)

## Cron Jobs

| Job                    | Schedule    | Purpose                                         |
| ---------------------- | ----------- | ----------------------------------------------- |
| `reconcile_expired`    | Every 5 min | Expire unpaid reservations, release cells       |
| `rebuild_manifest`     | Every 5 min | Regenerate wall manifest from active placements |
| `link_health`          | Daily       | Check destination URLs, disable broken links    |
| `leaderboard_snapshot` | Hourly      | Capture top placements by views/clicks          |

```mermaid
graph LR
    subgraph "Cron Dispatch"
        Cron[Cloudflare Cron] --> Worker
        Worker --> Job1[reconcile_expired]
        Worker --> Job2[rebuild_manifest]
        Worker --> Job3[link_health]
        Worker --> Job4[leaderboard_snapshot]
    end

    Job1 --> DB[(Supabase)]
    Job2 --> KV[(KV Cache)]
    Job3 --> External[External URLs]
    Job4 --> DB
```

## Cache Strategy

### Cache Layers

| Layer            | TTL    | Content                                |
| ---------------- | ------ | -------------------------------------- |
| CDN (Cloudflare) | 1 year | Static assets (immutable hashes)       |
| KV Cache         | 5 min  | Wall manifest, pricing, stats          |
| Browser          | 5 min  | API responses (stale-while-revalidate) |

### Cache Invalidation

```mermaid
graph TB
    subgraph "Invalidation Triggers"
        Payment[Payment Settled] --> Rebuild
        Moderation[Approval/Rejection] --> Rebuild
        Cron[Scheduled Rebuild] --> Rebuild
    end

    Rebuild[rebuild_manifest] --> KV[(KV Cache)]
    KV --> Manifest[New Manifest]
```

**Invalidation events:**

- Payment settled → Placement becomes active
- Moderation action → Placement visibility changes
- Reservation expired → Cells released

## API Routes

| Route                      | Method  | Auth   | Purpose                   |
| -------------------------- | ------- | ------ | ------------------------- |
| `/api/auth/*`              | Various | Public | PKCE auth flow            |
| `/api/public/pricing`      | GET     | Public | Current pricing info      |
| `/api/public/stats`        | GET     | Public | Aggregate statistics      |
| `/api/wall/manifest`       | GET     | Public | Active placements         |
| `/api/reservations/create` | POST    | Auth   | Reserve cells             |
| `/api/uploads/request`     | POST    | Auth   | Get presigned upload URL  |
| `/api/checkout/session`    | POST    | Auth   | Create Stripe session     |
| `/api/stripe/webhook`      | POST    | Stripe | Payment events            |
| `/api/dashboard/*`         | Various | Auth   | User dashboard            |
| `/api/admin/*`             | Various | Admin  | Moderation queue          |
| `/go/:id`                  | GET     | Public | Redirect to placement URL |

## Security Architecture

See [SECURITY.md](SECURITY.md) for detailed security documentation.

**Key security layers:**

1. **Edge**: CSRF, origin validation, rate limiting, body limits
2. **Database**: RLS policies, state machine triggers, immutable audit
3. **Payments**: Webhook signature verification, price from DB only
4. **Content**: Magic-byte image validation, no user HTML/JS/CSS

## Deployment Architecture

```mermaid
graph TB
    subgraph "Production"
        DNS[Cloudflare DNS]
        CF[Cloudflare Workers]
        KV1[(KV: CACHE_KV)]
        KV2[(KV: RATE_KV)]
        DO1[RateLimiterDO]
        DO2[AnalyticsBufferDO]
    end

    subgraph "Database"
        SB[Supabase Cloud]
        PG[(PostgreSQL 17)]
    end

    subgraph "External"
        Stripe[Stripe]
        Email[Spacemail SMTP]
    end

    DNS --> CF
    CF --> KV1
    CF --> KV2
    CF --> DO1
    CF --> DO2
    CF --> SB
    SB --> PG
    CF <--> Stripe
```

## File Structure

```
worker/
├── index.ts          # Entry point (fetch + scheduled)
├── app.ts            # Hono app factory
├── context.ts        # Request context types
├── middleware.ts     # Global middleware
├── env.ts            # Environment validation
├── routes/           # API route handlers
│   ├── admin.ts      # Moderation endpoints
│   ├── auth.ts       # PKCE auth flow
│   ├── checkout.ts   # Stripe checkout
│   ├── dashboard.ts  # User dashboard
│   ├── go.ts         # Redirect handler
│   ├── public.ts     # Public data
│   ├── reservations.ts # Cell reservation
│   ├── seo.ts        # robots.txt, sitemap
│   ├── stripe-webhook.ts # Payment webhooks
│   └── uploads.ts    # Image upload
├── lib/              # Shared utilities
│   ├── audit.ts      # Audit logging
│   ├── auth.ts       # Session management
│   ├── cache.ts      # Cache helpers
│   ├── cookies.ts    # Cookie parsing
│   ├── crypto.ts     # HMAC, signatures
│   ├── csrf.ts       # CSRF protection
│   ├── errors.ts     # Error handling
│   ├── http-security.ts # CSP headers
│   ├── images.ts     # Magic-byte validation
│   ├── logger.ts     # Redacting logger
│   ├── rate-limit.ts # DO rate limiting
│   ├── stripe.ts     # Stripe client
│   ├── supabase.ts   # Typed RPC client
│   └── turnstile.ts  # CAPTCHA verification
├── do/               # Durable Objects
│   ├── RateLimiterDO.ts
│   └── AnalyticsBufferDO.ts
└── jobs/             # Scheduled jobs
    ├── cron-dispatch.ts
    ├── reconcile-expire.ts
    ├── rebuild-manifest.ts
    └── link-health.ts
```
