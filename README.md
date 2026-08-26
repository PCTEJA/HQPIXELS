# HQPixels

An interactive pixel-ad marketplace for [hqpixels.com](https://hqpixels.com). Users purchase rectangular regions on a 1000x1000 logical-pixel wall, upload images, and link to destinations. Placements are moderated before going live.

## Features

- **Interactive Pixel Wall**: PixiJS-powered canvas with pan/zoom, hover previews, and click-through
- **Claim Flow**: Select region, Stripe Checkout, upload image, await moderation
- **Dynamic Pricing**: Zone-based multipliers with volume discounts
- **Admin Moderation**: Queue-based review with approve/reject/disable actions
- **Analytics**: View counts, click tracking, leaderboards, and stats pages
- **Accessibility**: WCAG 2.1 AA compliant, keyboard navigable, reduced-motion support

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite 6, Tailwind CSS 4, PixiJS 8, TanStack Query 5 |
| Backend | Hono 4 on Cloudflare Workers |
| Database | Supabase (PostgreSQL 17) with RLS |
| Payments | Stripe Checkout + webhooks |
| Validation | Zod 3 |
| Testing | Vitest 3, Playwright 1.6x |

## Quick Start

### Prerequisites

- Node.js 22.11.0+
- pnpm 10.0.0+
- PostgreSQL 17 (for local DB testing)
- Stripe CLI (for webhook testing)

### Installation

```bash
# Clone and install dependencies
git clone https://github.com/your-org/hqpixels.git
cd hqpixels
pnpm install
```

### Environment Variables

Create `.dev.vars` for local Worker development:

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...

# Turnstile (CAPTCHA)
TURNSTILE_SECRET_KEY=...

# Security
CSRF_SECRET=<32+ random bytes>
COOKIE_SECRET=<32+ random bytes>
ADMIN_EMAIL_ALLOWLIST=admin@example.com
```

Create `.env` for client-side (public values only):

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_TURNSTILE_SITE_KEY=...
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

### Development

```bash
# Start dev server (client + API)
pnpm dev

# In another terminal, forward Stripe webhooks
pnpm stripe:listen
```

Visit [http://localhost:5173](http://localhost:5173).

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start Vite dev server |
| `pnpm build` | Typecheck, generate headers, build for production |
| `pnpm test` | Run Vitest unit tests |
| `pnpm test:e2e` | Run Playwright E2E tests |
| `pnpm test:a11y` | Run accessibility tests only |
| `pnpm typecheck` | Check all TypeScript configs |
| `pnpm lint` | ESLint with zero warnings |
| `pnpm format` | Prettier format all files |
| `pnpm verify` | Full verification (format, lint, typecheck, test) |
| `pnpm deploy:staging` | Deploy to Cloudflare Workers staging |
| `pnpm deploy:production` | Deploy to Cloudflare Workers production |

## Project Structure

```
├── src/                 # React client application
│   ├── components/      # Shared UI components
│   ├── lib/             # Utilities, hooks, queries
│   └── routes/          # Page components
├── worker/              # Cloudflare Worker API
│   ├── routes/          # API route handlers
│   ├── lib/             # Shared utilities
│   ├── do/              # Durable Objects
│   └── jobs/            # Scheduled jobs
├── shared/              # Code shared between client and worker
├── supabase/            # Database migrations and tests
│   ├── migrations/      # SQL migration files
│   └── tests/           # pgTAP test files
├── tests/               # Test suites
│   ├── unit/            # Vitest unit tests
│   ├── integration/     # API integration tests
│   ├── e2e/             # Playwright E2E tests
│   └── load/            # k6 load tests
└── public/              # Static assets
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System design and diagrams
- [SECURITY.md](SECURITY.md) - Security posture and risk register
- [THREAT_MODEL.md](THREAT_MODEL.md) - STRIDE threat analysis
- [DEPLOYMENT.md](DEPLOYMENT.md) - Production deployment guide
- [STRIPE_SETUP.md](STRIPE_SETUP.md) - Stripe configuration
- [RUNBOOK.md](RUNBOOK.md) - Operational procedures
- [COSTS.md](COSTS.md) - Infrastructure cost estimates
- [PRD.md](PRD.md) - Product Requirements Document

## Wall Geometry

- **Wall Size**: 1000x1000 logical pixels
- **Cell Size**: 10x10 logical pixels (1 purchasable unit)
- **Grid**: 100x100 cells (10,000 total)
- **Max Selection**: 50x50 cells (2,500 cells = 250,000 pixels)

## License

Proprietary. All rights reserved.
