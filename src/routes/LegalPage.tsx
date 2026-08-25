/**
 * Legal documents.
 *
 * One component renders all four policy documents from a single content map so
 * terminology and tone cannot drift. Each document displays a clear draft banner
 * stating it requires professional legal review before going live.
 *
 * Retention periods and data handling practices are derived directly from the
 * database migrations (purge_expired_privacy_data) and the worker code
 * (client-ip.ts) — they describe what the code actually does, not aspirational
 * policy.
 */

import { Link } from 'react-router-dom';
import { Alert } from '../components/primitives';

/** Must match CURRENT_TERMS_VERSION in worker/routes/reservations.ts and TERMS_VERSION in ClaimPage.tsx */
const TERMS_VERSION = '2026-08-01';
const LAST_UPDATED = 'August 1, 2026';

type DocumentType = 'terms' | 'privacy' | 'content-policy' | 'refund-policy';

interface LegalPageProps {
  readonly document: DocumentType;
}

interface DocumentContent {
  readonly title: string;
  readonly content: React.ReactNode;
}

const draftBanner = (
  <Alert tone="warning" title="Draft document" className="mb-8">
    <p className="text-sm">
      This document is a draft prepared for professional legal review. It is not yet legally binding
      and does not constitute legal advice. The final version will be published before the service
      launches.
    </p>
  </Alert>
);

function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h2 className="mb-3 mt-8 text-lg font-semibold">{children}</h2>;
}

function Paragraph({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="mb-4 text-sm text-ink-muted">{children}</p>;
}

function List({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ul className="mb-4 list-inside list-disc space-y-1 text-sm text-ink-muted">{children}</ul>
  );
}

const documents: Record<DocumentType, DocumentContent> = {
  terms: {
    title: 'Terms of Service',
    content: (
      <>
        <SectionHeading>1. Acceptance</SectionHeading>
        <Paragraph>
          By using HQPixels (&ldquo;the Service&rdquo;), you agree to these Terms of Service
          (&ldquo;Terms&rdquo;). If you do not agree, do not use the Service.
        </Paragraph>

        <SectionHeading>2. The Service</SectionHeading>
        <Paragraph>
          HQPixels operates a visual advertising wall where users may purchase permanent placements.
          Each placement consists of a rectangular region of the wall, an image, a title, alt text,
          and a destination link.
        </Paragraph>

        <SectionHeading>3. Account and identity</SectionHeading>
        <Paragraph>
          You may sign in using Google, GitHub, or a one-time email link. You are responsible for
          maintaining the security of your account. You must provide a valid email address that you
          control.
        </Paragraph>

        <SectionHeading>4. Purchases</SectionHeading>
        <List>
          <li>All prices are in US dollars and include applicable taxes where required.</li>
          <li>Payment is processed by Stripe. We do not store your full card number.</li>
          <li>
            A reservation holds cells for 45 minutes. If you do not complete checkout, the cells are
            released and you are not charged.
          </li>
          <li>The price quoted at reservation time is final and cannot change mid-checkout.</li>
          <li>
            Placements are subject to review. We may reject submissions that violate the{' '}
            <Link to="/content-policy" className="text-cyan hover:underline">
              Content Policy
            </Link>
            .
          </li>
        </List>

        <SectionHeading>5. Content and conduct</SectionHeading>
        <Paragraph>
          You retain ownership of the content you upload, but you grant HQPixels a worldwide,
          royalty-free license to display it on the wall. You represent that you have the right to
          use any images and text you submit.
        </Paragraph>
        <Paragraph>
          You agree not to upload content that is illegal, infringes intellectual property rights,
          contains malware, or violates the Content Policy.
        </Paragraph>

        <SectionHeading>6. Modifications and termination</SectionHeading>
        <Paragraph>
          We may modify these Terms with reasonable notice. Continued use after modifications
          constitutes acceptance. We may suspend or terminate accounts for violations.
        </Paragraph>

        <SectionHeading>7. Disclaimer of warranties</SectionHeading>
        <Paragraph>
          The Service is provided &ldquo;as is&rdquo; without warranties of any kind. We do not
          guarantee uptime, traffic, or any particular outcome from your placement.
        </Paragraph>

        <SectionHeading>8. Limitation of liability</SectionHeading>
        <Paragraph>
          To the maximum extent permitted by law, HQPixels&apos;s liability is limited to the amount
          you paid for the affected placement. We are not liable for indirect, incidental, or
          consequential damages.
        </Paragraph>

        <SectionHeading>9. Governing law</SectionHeading>
        <Paragraph>
          These Terms are governed by the laws of the jurisdiction in which HQPixels is
          incorporated, without regard to conflict of law principles.
        </Paragraph>
      </>
    ),
  },

  privacy: {
    title: 'Privacy Policy',
    content: (
      <>
        <SectionHeading>1. What we collect</SectionHeading>
        <Paragraph>
          We collect only what is necessary to operate the service and comply with abuse prevention
          obligations:
        </Paragraph>
        <List>
          <li>
            <strong>Email address:</strong> Used for authentication and transactional
            communications.
          </li>
          <li>
            <strong>Display name and handle:</strong> Shown publicly on your placements.
          </li>
          <li>
            <strong>Payment information:</strong> Processed by Stripe. We receive only a partial
            card number and expiration for receipts; we never see or store your full card number.
          </li>
          <li>
            <strong>Network prefix:</strong> For abuse correlation, we store a truncated IP address
            (IPv4 /24 or IPv6 /48), not the full address. This is enough to detect coordinated abuse
            but not enough to identify a household.
          </li>
        </List>

        <SectionHeading>2. Retention periods</SectionHeading>
        <Paragraph>
          Data is retained only as long as necessary. These periods are enforced automatically by
          database cleanup jobs, not by manual processes:
        </Paragraph>
        <List>
          <li>
            <strong>Reservation network prefixes:</strong> 30 days, then erased.
          </li>
          <li>
            <strong>Abuse report network prefixes:</strong> 7 days, then erased.
          </li>
          <li>
            <strong>Audit log network prefixes:</strong> 90 days, then erased. The audit record
            itself (action, timestamp, actor) is retained permanently for integrity.
          </li>
          <li>
            <strong>Analytics buckets:</strong> 400 days, then deleted. Aggregate totals shown
            publicly are cumulative counters that do not require raw data retention.
          </li>
        </List>

        <SectionHeading>3. Analytics</SectionHeading>
        <Paragraph>
          We aggregate page views and clicks in 5-minute buckets. We do not store raw IP addresses
          for analytics — only the truncated network prefix, and only for abuse correlation with the
          retention windows above. We do not use cookies for analytics, fingerprinting, or
          cross-site tracking.
        </Paragraph>

        <SectionHeading>4. Third-party processors</SectionHeading>
        <List>
          <li>
            <strong>Stripe:</strong> Payment processor. Stripe&apos;s privacy policy governs data
            they collect during checkout.
          </li>
          <li>
            <strong>Supabase:</strong> Database hosting and authentication. Data is stored in
            Supabase&apos;s infrastructure.
          </li>
          <li>
            <strong>Cloudflare:</strong> CDN, DNS, and bot protection. Cloudflare&apos;s privacy
            policy governs their edge processing.
          </li>
        </List>

        <SectionHeading>5. Data sharing</SectionHeading>
        <Paragraph>
          We do not sell personal data. We share data only with the processors above and when
          required by law (e.g., valid legal process).
        </Paragraph>

        <SectionHeading>6. Your rights</SectionHeading>
        <Paragraph>
          Depending on your jurisdiction, you may have rights to access, correct, or delete your
          personal data. Contact us at{' '}
          <a href="mailto:hello@hqpixels.com" className="text-cyan hover:underline">
            hello@hqpixels.com
          </a>{' '}
          to exercise these rights.
        </Paragraph>

        <SectionHeading>7. Security</SectionHeading>
        <Paragraph>
          We use HTTPS everywhere, store passwords only as secure hashes (via Supabase Auth), and
          never log full IP addresses. Session cookies are HttpOnly and SameSite=Lax. For security
          concerns, contact{' '}
          <a href="mailto:security@hqpixels.com" className="text-cyan hover:underline">
            security@hqpixels.com
          </a>
          .
        </Paragraph>
      </>
    ),
  },

  'content-policy': {
    title: 'Content Policy',
    content: (
      <>
        <SectionHeading>1. Scope</SectionHeading>
        <Paragraph>
          This policy applies to all content submitted to HQPixels, including images, titles, alt
          text, and destination URLs.
        </Paragraph>

        <SectionHeading>2. Prohibited content</SectionHeading>
        <Paragraph>The following are not allowed:</Paragraph>
        <List>
          <li>
            <strong>Malware and phishing:</strong> Links to sites that distribute malware, attempt
            to steal credentials, or deceive users about their identity.
          </li>
          <li>
            <strong>Illegal content:</strong> Anything illegal in the United States or the
            buyer&apos;s jurisdiction, including but not limited to child exploitation material,
            controlled substances, and prohibited weapons.
          </li>
          <li>
            <strong>Adult content:</strong> Sexually explicit material without appropriate labeling.
            Artistic nudity may be permitted with proper context and labeling.
          </li>
          <li>
            <strong>Violence and hate:</strong> Content promoting violence, terrorism, or hatred
            against protected groups.
          </li>
          <li>
            <strong>Misleading content:</strong> Deceptive claims, fake testimonials, or content
            designed to mislead visitors about the nature of what they will find.
          </li>
          <li>
            <strong>Intellectual property violations:</strong> Content you do not have the right to
            use, including copyrighted images and trademarks.
          </li>
          <li>
            <strong>Spam:</strong> Irrelevant, repetitive, or low-quality content intended to game
            the system.
          </li>
        </List>

        <SectionHeading>3. Destination links</SectionHeading>
        <Paragraph>
          Links must lead to legitimate websites that match the placement&apos;s representation. We
          periodically re-check links. If your link becomes unreachable or starts pointing to
          prohibited content, your placement may be disabled.
        </Paragraph>
        <Paragraph>
          Changing your destination URL after approval triggers a new review. This is intentional
          and prevents bait-and-switch tactics.
        </Paragraph>

        <SectionHeading>4. Enforcement</SectionHeading>
        <List>
          <li>
            <strong>Pre-approval rejection:</strong> If we reject your submission before activation,
            you receive a full refund.
          </li>
          <li>
            <strong>Post-approval removal:</strong> If we discover a policy violation after
            approval, we may disable the placement. Refunds for post-approval removal are at our
            discretion.
          </li>
          <li>
            <strong>Account suspension:</strong> Repeated or severe violations may result in
            permanent account suspension.
          </li>
        </List>

        <SectionHeading>5. Appeals</SectionHeading>
        <Paragraph>
          If you believe your content was incorrectly rejected or removed, contact{' '}
          <a href="mailto:hello@hqpixels.com" className="text-cyan hover:underline">
            hello@hqpixels.com
          </a>{' '}
          with your placement ID. We will review the decision and respond within 5 business days.
        </Paragraph>
      </>
    ),
  },

  'refund-policy': {
    title: 'Refund Policy',
    content: (
      <>
        <SectionHeading>1. Moderation rejection</SectionHeading>
        <Paragraph>
          If your placement is rejected during the moderation review (before it goes live), you
          receive a <strong>full refund</strong> of the purchase price. The cells become available
          again.
        </Paragraph>

        <SectionHeading>2. Expired reservations</SectionHeading>
        <Paragraph>
          If you do not complete checkout within the 45-minute hold period, your reservation expires
          and the cells are released. <strong>You are never charged</strong> for an expired hold —
          payment only occurs after you complete Stripe Checkout.
        </Paragraph>

        <SectionHeading>3. After approval</SectionHeading>
        <Paragraph>
          Once a placement is approved and live on the wall, refunds are generally not available.
          Placements are permanent by design. Exceptions may apply where required by law.
        </Paragraph>

        <SectionHeading>4. Chargebacks and disputes</SectionHeading>
        <Paragraph>
          If you file a chargeback or payment dispute with your bank or card issuer, and the dispute
          is resolved in your favor, your placement will be removed from the wall and your account
          may be suspended.
        </Paragraph>

        <SectionHeading>5. Service issues</SectionHeading>
        <Paragraph>
          If a technical error on our part prevents your placement from being displayed correctly,
          contact us and we will work to resolve the issue or provide an appropriate remedy.
        </Paragraph>

        <SectionHeading>6. How to request a refund</SectionHeading>
        <Paragraph>
          For eligible refund requests, email{' '}
          <a href="mailto:hello@hqpixels.com" className="text-cyan hover:underline">
            hello@hqpixels.com
          </a>{' '}
          with your placement ID and the email address used for purchase. Refunds are processed to
          the original payment method within 5–10 business days.
        </Paragraph>
      </>
    ),
  },
};

export function LegalPage({ document }: LegalPageProps): React.JSX.Element {
  const doc = documents[document];

  return (
    <div className="max-w-3xl">
      {draftBanner}

      <header className="mb-8">
        <h1 className="text-3xl font-semibold">{doc.title}</h1>
        <p className="mt-2 text-sm text-ink-subtle">
          Last updated: {LAST_UPDATED} &middot; Version {TERMS_VERSION}
        </p>
      </header>

      <div className="prose prose-invert max-w-none">{doc.content}</div>

      <nav className="mt-12 border-t border-hairline pt-6" aria-label="Related documents">
        <p className="mb-3 text-sm font-medium">Related documents</p>
        <ul className="flex flex-wrap gap-4 text-sm">
          {document !== 'terms' && (
            <li>
              <Link to="/terms" className="text-cyan hover:underline">
                Terms of Service
              </Link>
            </li>
          )}
          {document !== 'privacy' && (
            <li>
              <Link to="/privacy" className="text-cyan hover:underline">
                Privacy Policy
              </Link>
            </li>
          )}
          {document !== 'content-policy' && (
            <li>
              <Link to="/content-policy" className="text-cyan hover:underline">
                Content Policy
              </Link>
            </li>
          )}
          {document !== 'refund-policy' && (
            <li>
              <Link to="/refund-policy" className="text-cyan hover:underline">
                Refund Policy
              </Link>
            </li>
          )}
        </ul>
      </nav>
    </div>
  );
}

export default LegalPage;
