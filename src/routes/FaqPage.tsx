/**
 * Frequently asked questions.
 *
 * Real answers derived from the codebase. The accordion pattern uses native
 * details/summary for full keyboard and screen-reader support without
 * JavaScript dependencies.
 */

import { Link } from 'react-router-dom';
import {
  CELL_LOGICAL_SIZE,
  MAX_IMAGE_DIMENSION,
  MAX_UPLOAD_BYTES,
  RESERVATION_TTL_SECONDS,
  ALLOWED_IMAGE_MIME_TYPES,
} from '@shared/constants';

interface FaqItemProps {
  readonly question: string;
  readonly children: React.ReactNode;
  readonly id?: string;
}

function FaqItem({ question, children, id }: FaqItemProps): React.JSX.Element {
  return (
    <details
      id={id}
      className="group rounded-lg border border-hairline bg-surface-raised transition-colors open:border-cyan/40"
    >
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium transition-colors hover:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-ground">
        {question}
      </summary>
      <div className="px-4 pb-4 pt-1 text-sm text-ink-muted">{children}</div>
    </details>
  );
}

export function FaqPage(): React.JSX.Element {
  const holdMinutes = Math.floor(RESERVATION_TTL_SECONDS / 60);
  const maxUploadMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
  const allowedFormats = ALLOWED_IMAGE_MIME_TYPES.map((t) => t.replace('image/', '').toUpperCase());

  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-semibold">Frequently asked questions</h1>
      <p className="mt-2 text-ink-muted">
        If your question is not answered here,{' '}
        <Link to="/contact" className="text-cyan hover:underline">
          contact us
        </Link>
        .
      </p>

      {/* --- the product -------------------------------------------------- */}
      <section aria-labelledby="product-heading" className="mt-10">
        <h2 id="product-heading" className="mb-4 text-lg font-semibold">
          The product
        </h2>
        <div className="space-y-3">
          <FaqItem question="What do I get when I buy?">
            <p>
              You get permanent visual real estate on the HQPixels wall. Your image, title, and link
              appear on the public wall at the coordinates you chose, for as long as HQPixels
              operates. You also get a dashboard showing impressions and clicks.
            </p>
          </FaqItem>

          <FaqItem question="Is my placement permanent?">
            <p>
              Yes. Once paid and approved, your placement stays indefinitely. We do not sell
              &ldquo;rental&rdquo; slots or time-limited ads. The only removal scenarios are
              violations of the{' '}
              <Link to="/content-policy" className="text-cyan hover:underline">
                content policy
              </Link>{' '}
              or payment disputes (chargebacks).
            </p>
          </FaqItem>

          <FaqItem question="What image formats and sizes are accepted?">
            <p>
              We accept {allowedFormats.join(', ')} images up to {maxUploadMb} MB and{' '}
              {MAX_IMAGE_DIMENSION.toLocaleString()} pixels on the longest side. SVG, GIF, PDF, and
              other formats are not allowed for security reasons.
            </p>
            <p className="mt-2">
              Your image should be at least as large as your selection. One unit is{' '}
              {CELL_LOGICAL_SIZE}&times;{CELL_LOGICAL_SIZE} logical pixels, so a 5&times;5 selection
              is 50&times;50 pixels at minimum.
            </p>
          </FaqItem>

          <FaqItem question="Why is alt text required?">
            <p>
              Alt text makes the wall accessible to visitors who use screen readers or who have
              images disabled. It is a requirement, not an option. A good alt text describes what
              the image shows so that a blind user understands the content.
            </p>
          </FaqItem>
        </div>
      </section>

      {/* --- moderation --------------------------------------------------- */}
      <section aria-labelledby="moderation-heading" className="mt-10">
        <h2 id="moderation-heading" className="mb-4 text-lg font-semibold">
          Review and moderation
        </h2>
        <div className="space-y-3">
          <FaqItem question="How does the review process work?">
            <p>
              After payment, your placement enters a review queue. We check that the image,
              destination link, and metadata comply with our{' '}
              <Link to="/content-policy" className="text-cyan hover:underline">
                content policy
              </Link>
              . Once approved, your placement goes live on the wall.
            </p>
          </FaqItem>

          <FaqItem question="How long does review take?">
            <p>
              We aim to review submissions within 24 hours. During launch or high-volume periods it
              may take longer. You can check your placement status in your{' '}
              <Link to="/dashboard" className="text-cyan hover:underline">
                dashboard
              </Link>
              .
            </p>
          </FaqItem>

          <FaqItem question="What happens if my placement is rejected?">
            <p>
              If your submission violates our content policy, you receive a full refund and the
              cells become available again. You will receive an email explaining the reason.
            </p>
          </FaqItem>

          <FaqItem question="Can I change my link after approval?">
            <p>
              Yes, but changing the destination URL re-enters your placement into the review queue.
              This is intentional: it prevents someone from passing review with a benign link and
              then switching to a malicious one.
            </p>
          </FaqItem>
        </div>
      </section>

      {/* --- payment ------------------------------------------------------ */}
      <section aria-labelledby="payment-heading" className="mt-10">
        <h2 id="payment-heading" className="mb-4 text-lg font-semibold">
          Payment and refunds
        </h2>
        <div className="space-y-3">
          <FaqItem question="What happens if my hold expires?">
            <p>
              When you select cells, they are held for {holdMinutes} minutes. If you do not complete
              checkout in that time, the cells are automatically released and you are not charged.
              You can start a new reservation for the same cells (if still available) or different
              ones.
            </p>
          </FaqItem>

          <FaqItem question="What is your refund policy?">
            <p>
              Full refund if we reject your placement during moderation. No refund after approval
              unless legally required. Chargebacks remove your placement. See the full{' '}
              <Link to="/refund-policy" className="text-cyan hover:underline">
                refund policy
              </Link>{' '}
              for details.
            </p>
          </FaqItem>

          <FaqItem question="What payment methods are accepted?">
            <p>
              We use Stripe Checkout, which supports cards (Visa, Mastercard, Amex, etc.), Apple
              Pay, Google Pay, and other regional methods. The available options depend on your
              location.
            </p>
          </FaqItem>
        </div>
      </section>

      {/* --- analytics ---------------------------------------------------- */}
      <section aria-labelledby="analytics-heading" className="mt-10">
        <h2 id="analytics-heading" className="mb-4 text-lg font-semibold">
          Analytics and clicks
        </h2>
        <div className="space-y-3">
          <FaqItem question="How are clicks counted?">
            <p>
              Every outbound click through your placement is logged. We filter out obvious bots and
              automated traffic, but the number shown is total clicks, not unique visitors. Your
              dashboard shows both raw and filtered counts.
            </p>
          </FaqItem>

          <FaqItem question='Why does the stats page say "page views" and not "visitors"?'>
            <p>
              Because we do not track unique visitors. &ldquo;Total page views&rdquo; counts page
              loads, not people. One person reloading five times is five page views. We do not use
              cookies or fingerprinting to deduplicate, so we state exactly what we measure.
            </p>
          </FaqItem>

          <FaqItem question="Do outbound links affect SEO?">
            <p>
              Outbound links from placements include{' '}
              <code className="rounded bg-surface-sunken px-1 py-0.5 text-xs">
                rel=&quot;sponsored nofollow&quot;
              </code>
              . This tells search engines that the link is paid and should not pass ranking credit.
              This is the standard for advertising.
            </p>
          </FaqItem>

          <FaqItem question="What is link re-checking?" id="link-checks">
            <p>
              We periodically verify that destination links are still reachable. If your link
              returns errors consistently (DNS failure, connection refused, 4xx or 5xx responses),
              the placement may be automatically disabled to protect visitors. You will be notified
              and can update the link in your dashboard.
            </p>
            <p className="mt-2">
              The link checker identifies itself with the User-Agent string{' '}
              <code className="rounded bg-surface-sunken px-1 py-0.5 text-xs">
                HQPixelsBot/1.0 (+https://hqpixels.com/faq#link-checks)
              </code>
              . If your server blocks it, please allowlist that user agent.
            </p>
          </FaqItem>
        </div>
      </section>

      {/* --- abuse -------------------------------------------------------- */}
      <section aria-labelledby="abuse-heading" className="mt-10">
        <h2 id="abuse-heading" className="mb-4 text-lg font-semibold">
          Reporting abuse
        </h2>
        <div className="space-y-3">
          <FaqItem question="How do I report a problematic placement?">
            <p>
              Use the{' '}
              <Link to="/contact" className="text-cyan hover:underline">
                abuse report form
              </Link>{' '}
              on our contact page. Include the placement coordinates or title if you can. We review
              reports promptly and take appropriate action.
            </p>
          </FaqItem>

          <FaqItem question="What content is not allowed?">
            <p>
              Malware, phishing, illegal content, adult content without appropriate context,
              misleading claims, and anything that violates applicable law. See the full{' '}
              <Link to="/content-policy" className="text-cyan hover:underline">
                content policy
              </Link>
              .
            </p>
          </FaqItem>
        </div>
      </section>

      {/* --- call to action ---------------------------------------------- */}
      <div className="mt-12 text-center">
        <p className="text-ink-muted">Ready to get started?</p>
        <Link to="/claim" className="btn btn-cta mt-4 inline-block no-underline">
          Claim your space
        </Link>
      </div>
    </div>
  );
}

export default FaqPage;
