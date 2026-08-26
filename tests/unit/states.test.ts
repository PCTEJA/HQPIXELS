/**
 * Unit tests for shared/states.ts.
 *
 * The reservation state machine is critical for ensuring money and cells
 * are handled correctly. These tests verify transition rules.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  RESERVATION_STATES,
  STATES_ELIGIBLE_FOR_EXPIRY,
  STATES_HOLDING_CELLS,
} from '@shared/states';

describe('RESERVATION_STATES', () => {
  it('contains all expected states', () => {
    expect(RESERVATION_STATES).toContain('draft');
    expect(RESERVATION_STATES).toContain('reserved');
    expect(RESERVATION_STATES).toContain('ready_for_checkout');
    expect(RESERVATION_STATES).toContain('checkout_created');
    expect(RESERVATION_STATES).toContain('paid_pending_review');
    expect(RESERVATION_STATES).toContain('active');
    expect(RESERVATION_STATES).toContain('expired');
    expect(RESERVATION_STATES).toContain('payment_failed');
    expect(RESERVATION_STATES).toContain('rejected_refunded');
    expect(RESERVATION_STATES).toContain('disabled');
    expect(RESERVATION_STATES).toContain('chargeback_disabled');
  });

  it('has no duplicate states', () => {
    const unique = new Set(RESERVATION_STATES);
    expect(unique.size).toBe(RESERVATION_STATES.length);
  });
});

describe('canTransition', () => {
  describe('happy path: draft to active', () => {
    it('allows draft -> reserved', () => {
      expect(canTransition('draft', 'reserved')).toBe(true);
    });

    it('allows reserved -> ready_for_checkout', () => {
      expect(canTransition('reserved', 'ready_for_checkout')).toBe(true);
    });

    it('allows ready_for_checkout -> checkout_created', () => {
      expect(canTransition('ready_for_checkout', 'checkout_created')).toBe(true);
    });

    it('allows checkout_created -> paid_pending_review', () => {
      expect(canTransition('checkout_created', 'paid_pending_review')).toBe(true);
    });

    it('allows paid_pending_review -> active', () => {
      expect(canTransition('paid_pending_review', 'active')).toBe(true);
    });
  });

  describe('expiry transitions', () => {
    it('allows draft -> expired', () => {
      expect(canTransition('draft', 'expired')).toBe(true);
    });

    it('allows reserved -> expired', () => {
      expect(canTransition('reserved', 'expired')).toBe(true);
    });

    it('allows ready_for_checkout -> expired', () => {
      expect(canTransition('ready_for_checkout', 'expired')).toBe(true);
    });

    it('allows checkout_created -> expired', () => {
      expect(canTransition('checkout_created', 'expired')).toBe(true);
    });

    it('does NOT allow paid_pending_review -> expired (money prevents expiry)', () => {
      expect(canTransition('paid_pending_review', 'expired')).toBe(false);
    });

    it('does NOT allow active -> expired', () => {
      expect(canTransition('active', 'expired')).toBe(false);
    });
  });

  describe('payment failure and retry', () => {
    it('allows checkout_created -> payment_failed', () => {
      expect(canTransition('checkout_created', 'payment_failed')).toBe(true);
    });

    it('allows payment_failed -> ready_for_checkout (retry)', () => {
      expect(canTransition('payment_failed', 'ready_for_checkout')).toBe(true);
    });
  });

  describe('checkout cancellation', () => {
    it('allows checkout_created -> ready_for_checkout (cancelled session)', () => {
      expect(canTransition('checkout_created', 'ready_for_checkout')).toBe(true);
    });

    it('does NOT allow checkout_created -> reserved (must go through ready_for_checkout)', () => {
      expect(canTransition('checkout_created', 'reserved')).toBe(false);
    });
  });

  describe('moderation paths', () => {
    it('allows paid_pending_review -> rejected_refunded', () => {
      expect(canTransition('paid_pending_review', 'rejected_refunded')).toBe(true);
    });

    it('allows active -> disabled', () => {
      expect(canTransition('active', 'disabled')).toBe(true);
    });

    it('allows disabled -> active (re-enable)', () => {
      expect(canTransition('disabled', 'active')).toBe(true);
    });

    it('allows active -> rejected_refunded', () => {
      expect(canTransition('active', 'rejected_refunded')).toBe(true);
    });
  });

  describe('chargeback paths', () => {
    it('allows paid_pending_review -> chargeback_disabled', () => {
      expect(canTransition('paid_pending_review', 'chargeback_disabled')).toBe(true);
    });

    it('allows active -> chargeback_disabled', () => {
      expect(canTransition('active', 'chargeback_disabled')).toBe(true);
    });

    it('allows disabled -> chargeback_disabled', () => {
      expect(canTransition('disabled', 'chargeback_disabled')).toBe(true);
    });
  });

  describe('terminal states', () => {
    it('expired has no outbound transitions', () => {
      expect(ALLOWED_TRANSITIONS.expired).toEqual([]);
      for (const state of RESERVATION_STATES) {
        if (state !== 'expired') {
          expect(canTransition('expired', state)).toBe(false);
        }
      }
    });

    it('rejected_refunded has no outbound transitions', () => {
      expect(ALLOWED_TRANSITIONS.rejected_refunded).toEqual([]);
    });

    it('chargeback_disabled has no outbound transitions', () => {
      expect(ALLOWED_TRANSITIONS.chargeback_disabled).toEqual([]);
    });
  });

  describe('invalid transitions', () => {
    it('does NOT allow jumping from draft to active', () => {
      expect(canTransition('draft', 'active')).toBe(false);
    });

    it('does NOT allow going backwards from active to reserved', () => {
      expect(canTransition('active', 'reserved')).toBe(false);
    });

    it('does NOT allow self-transitions', () => {
      for (const state of RESERVATION_STATES) {
        expect(canTransition(state, state)).toBe(false);
      }
    });

    it('does NOT allow active -> paid_pending_review (cannot un-approve)', () => {
      expect(canTransition('active', 'paid_pending_review')).toBe(false);
    });
  });
});

describe('STATES_HOLDING_CELLS', () => {
  it('includes all pre-release states', () => {
    expect(STATES_HOLDING_CELLS).toContain('draft');
    expect(STATES_HOLDING_CELLS).toContain('reserved');
    expect(STATES_HOLDING_CELLS).toContain('ready_for_checkout');
    expect(STATES_HOLDING_CELLS).toContain('checkout_created');
    expect(STATES_HOLDING_CELLS).toContain('paid_pending_review');
    expect(STATES_HOLDING_CELLS).toContain('active');
    expect(STATES_HOLDING_CELLS).toContain('disabled');
  });

  it('does NOT include expired', () => {
    expect(STATES_HOLDING_CELLS).not.toContain('expired');
  });

  it('does NOT include payment_failed', () => {
    expect(STATES_HOLDING_CELLS).not.toContain('payment_failed');
  });

  it('does NOT include rejected_refunded', () => {
    expect(STATES_HOLDING_CELLS).not.toContain('rejected_refunded');
  });

  it('does NOT include chargeback_disabled', () => {
    expect(STATES_HOLDING_CELLS).not.toContain('chargeback_disabled');
  });
});

describe('STATES_ELIGIBLE_FOR_EXPIRY', () => {
  it('includes pre-payment states', () => {
    expect(STATES_ELIGIBLE_FOR_EXPIRY).toContain('draft');
    expect(STATES_ELIGIBLE_FOR_EXPIRY).toContain('reserved');
    expect(STATES_ELIGIBLE_FOR_EXPIRY).toContain('ready_for_checkout');
    expect(STATES_ELIGIBLE_FOR_EXPIRY).toContain('checkout_created');
  });

  it('does NOT include paid states', () => {
    expect(STATES_ELIGIBLE_FOR_EXPIRY).not.toContain('paid_pending_review');
    expect(STATES_ELIGIBLE_FOR_EXPIRY).not.toContain('active');
  });

  it('does NOT include terminal states', () => {
    expect(STATES_ELIGIBLE_FOR_EXPIRY).not.toContain('expired');
    expect(STATES_ELIGIBLE_FOR_EXPIRY).not.toContain('rejected_refunded');
    expect(STATES_ELIGIBLE_FOR_EXPIRY).not.toContain('chargeback_disabled');
  });
});

describe('ALLOWED_TRANSITIONS completeness', () => {
  it('every state has a transitions array', () => {
    for (const state of RESERVATION_STATES) {
      expect(ALLOWED_TRANSITIONS[state]).toBeDefined();
      expect(Array.isArray(ALLOWED_TRANSITIONS[state])).toBe(true);
    }
  });

  it('all target states in transitions are valid', () => {
    for (const state of RESERVATION_STATES) {
      for (const target of ALLOWED_TRANSITIONS[state]) {
        expect(RESERVATION_STATES).toContain(target);
      }
    }
  });
});
