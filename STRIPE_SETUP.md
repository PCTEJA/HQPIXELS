# Stripe Setup Guide

This guide covers configuring Stripe for HQPixels payment processing.

## Test Mode vs Live Mode

| Mode | API Keys | Webhooks | Real Money |
|------|----------|----------|------------|
| Test | `sk_test_*`, `pk_test_*` | Test endpoint | No |
| Live | `sk_live_*`, `pk_live_*` | Production endpoint | Yes |

**Always complete testing in test mode before going live.**

## 1. Create Stripe Account

1. Go to [stripe.com](https://stripe.com) and create an account
2. Complete business verification for live payments
3. Note: Live mode requires identity verification and bank account

## 2. API Keys

### Get Test Keys

1. Dashboard → Developers → API Keys
2. Toggle "Test mode" in the header
3. Copy:
   - **Publishable key**: `pk_test_...` (safe for client)
   - **Secret key**: `sk_test_...` (never expose!)

### Get Live Keys (after verification)

1. Toggle to "Live mode"
2. Copy live keys (handle with care)

### Configure Keys

Client (`.env`):
```env
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

Server:
```bash
wrangler secret put STRIPE_SECRET_KEY
# Enter: sk_test_...
```

## 3. Webhook Configuration

### 3.1 Create Webhook Endpoint

1. Dashboard → Developers → Webhooks
2. Click "Add endpoint"
3. **Endpoint URL**: `https://hqpixels.com/api/stripe/webhook`
4. **Description**: HQPixels payment events

### 3.2 Select Events

Subscribe to these events:

| Event | Purpose |
|-------|---------|
| `checkout.session.completed` | Payment successful |
| `checkout.session.expired` | Checkout abandoned |
| `checkout.session.async_payment_succeeded` | Delayed payment confirmed |
| `checkout.session.async_payment_failed` | Delayed payment failed |
| `charge.refunded` | Refund processed |
| `charge.dispute.created` | Chargeback initiated |
| `charge.dispute.closed` | Chargeback resolved |

### 3.3 Get Webhook Secret

After creating the endpoint:
1. Click on the endpoint
2. Click "Reveal" under Signing secret
3. Copy `whsec_...`

```bash
wrangler secret put STRIPE_WEBHOOK_SECRET
# Enter: whsec_...
```

## 4. Local Development with Stripe CLI

### 4.1 Install Stripe CLI

```bash
# Windows (Scoop)
scoop install stripe

# macOS
brew install stripe/stripe-cli/stripe

# Or download from https://stripe.com/docs/stripe-cli
```

### 4.2 Login

```bash
stripe login
```

### 4.3 Forward Webhooks

```bash
# Forward to local dev server
stripe listen --forward-to http://localhost:5173/api/stripe/webhook

# This outputs a webhook signing secret for local testing
# Use this secret in .dev.vars for local development
```

Keep this running during development. Events will be forwarded to your local server.

### 4.4 Trigger Test Events

```bash
# Trigger a checkout completion
stripe trigger checkout.session.completed

# Trigger a refund
stripe trigger charge.refunded

# List available triggers
stripe trigger --list
```

## 5. Checkout Session Configuration

HQPixels creates Checkout Sessions dynamically. Key parameters:

```typescript
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card'],
  line_items: [{
    price_data: {
      currency: 'usd',
      unit_amount: totalCents, // Computed from database
      product_data: {
        name: `HQPixels: ${widthCells}x${heightCells} cells`,
        description: `${cellCount} cells at position (${cellX}, ${cellY})`,
      },
    },
    quantity: 1,
  }],
  success_url: `${baseUrl}/claim/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${baseUrl}/claim/cancelled?reservation_id=${reservationId}`,
  client_reference_id: reservationId,
  expires_at: Math.floor(expiresAt.getTime() / 1000),
  metadata: {
    reservation_id: reservationId,
    cell_x: cellX.toString(),
    cell_y: cellY.toString(),
    width_cells: widthCells.toString(),
    height_cells: heightCells.toString(),
  },
});
```

### Important Notes

- `unit_amount` is computed from `quote_total_cents()` in the database
- `expires_at` must be at least 30 minutes in the future (Stripe requirement)
- `client_reference_id` links back to the reservation
- Metadata is stored with the payment for reconciliation

## 6. Webhook Handling

### Signature Verification

```typescript
// worker/routes/stripe-webhook.ts
const rawBody = await c.req.text();
const signature = c.req.header('stripe-signature');

// CRITICAL: Verify on raw body before parsing
let event: Stripe.Event;
try {
  event = stripe.webhooks.constructEvent(
    rawBody,
    signature!,
    webhookSecret
  );
} catch (err) {
  logger.warn('Webhook signature verification failed');
  return c.json({ error: 'Invalid signature' }, 400);
}
```

### Idempotency

```typescript
// Check if already processed
const { recorded } = await db.rpc('record_stripe_event', {
  event_id: event.id,
  event_type: event.type,
  payload: event.data.object,
});

if (!recorded) {
  // Already processed, acknowledge without re-processing
  return c.json({ received: true });
}
```

### Event Handlers

```typescript
switch (event.type) {
  case 'checkout.session.completed':
    await handleCheckoutCompleted(event.data.object);
    break;
  case 'checkout.session.expired':
    await handleCheckoutExpired(event.data.object);
    break;
  case 'charge.refunded':
    await handleRefund(event.data.object);
    break;
  case 'charge.dispute.created':
    await handleDispute(event.data.object);
    break;
}
```

## 7. Test Card Numbers

| Card Number | Scenario |
|-------------|----------|
| `4242 4242 4242 4242` | Successful payment |
| `4000 0000 0000 0002` | Card declined |
| `4000 0000 0000 9995` | Insufficient funds |
| `4000 0000 0000 3220` | 3D Secure required |
| `4000 0000 0000 0341` | Attaching fails |

Use any future expiration date and any 3-digit CVC.

## 8. Testing Checklist

### Basic Flow

- [ ] Create reservation
- [ ] Redirect to Checkout
- [ ] Complete with test card `4242...`
- [ ] Verify `checkout.session.completed` received
- [ ] Verify reservation status updated to `paid`
- [ ] Verify payment record created

### Edge Cases

- [ ] Abandon checkout (let it expire)
- [ ] Verify `checkout.session.expired` handled
- [ ] Verify reservation released back to pool
- [ ] Double-click on "Pay" (idempotency)
- [ ] Refresh success page (no duplicate fulfillment)

### Refund Flow

- [ ] Issue refund from Stripe Dashboard
- [ ] Verify `charge.refunded` received
- [ ] Verify placement disabled
- [ ] Verify cells released

## 9. Going Live

### Pre-Launch Checklist

- [ ] Business verification complete
- [ ] Bank account connected
- [ ] Live webhook endpoint created
- [ ] Live keys deployed
- [ ] Test transaction with real card ($0.50 minimum)

### Switch to Live Mode

1. Create production webhook endpoint
2. Update secrets:
   ```bash
   wrangler secret put STRIPE_SECRET_KEY --env production
   # Enter live sk_live_... key
   
   wrangler secret put STRIPE_WEBHOOK_SECRET --env production
   # Enter live whsec_... secret
   ```
3. Update client env:
   ```env
   VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...
   ```
4. Deploy

### Post-Launch Verification

```bash
# Verify webhook is receiving events
stripe logs tail --live

# Check webhook delivery status in Dashboard
# Dashboard → Developers → Webhooks → (endpoint) → Logs
```

## 10. Monitoring & Alerts

### Stripe Dashboard

- **Payments** → Monitor success rate
- **Webhooks** → Check for failed deliveries
- **Radar** → Review fraud signals

### Recommended Alerts

In Dashboard → Settings → Email alerts:

- Failed payments above threshold
- Webhook failures
- New disputes
- Unusual activity

## 11. Dispute Handling

When a `charge.dispute.created` event is received:

1. **Immediate**: Disable the placement
2. **Review**: Check audit log for user activity
3. **Respond**: Submit evidence within 7 days
4. **Resolution**: Handle `charge.dispute.closed` event

See [RUNBOOK.md](RUNBOOK.md) for detailed dispute procedure.

## 12. Common Issues

### Webhook Not Receiving Events

1. Check endpoint URL is correct and accessible
2. Verify SSL certificate is valid
3. Check for 5xx errors in Cloudflare logs
4. Verify secret matches between Stripe and Wrangler

### Signature Verification Fails

1. Ensure using raw request body (not parsed JSON)
2. Check webhook secret is correct
3. Verify not double-parsing the body

### Checkout Session Expired Immediately

- `expires_at` must be at least 30 minutes in future
- Clock skew between server and Stripe

### Duplicate Fulfillment

- Always check `stripe_events.id` before processing
- Use `record_stripe_event()` RPC for idempotency

## 13. CLI Command Reference

```bash
# Listen for webhooks
stripe listen --forward-to http://localhost:5173/api/stripe/webhook

# Trigger events
stripe trigger checkout.session.completed
stripe trigger charge.refunded

# List recent events
stripe events list --limit 10

# Tail logs
stripe logs tail

# Create test customer
stripe customers create --email test@example.com

# View webhook endpoint
stripe webhooks endpoints list
```
