import { Link } from 'react-router-dom';
import { usePublicStats } from '../lib/queries';
import { formatCount } from '../lib/format';

/**
 * Footer.
 *
 * The inventory line here is real data from /api/public/stats, or nothing at all
 * while it loads. It never shows a placeholder number — a fake "1,234 plots
 * claimed" would be exactly the kind of fabricated social proof this product is
 * built to avoid.
 */
export function Footer(): React.JSX.Element {
  const stats = usePublicStats();
  const inventory = stats.data?.inventory;

  return (
    <footer className="mt-auto border-t border-hairline bg-surface-sunken">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-[0.9375rem] font-semibold text-ink">HQPixels</p>
            <p className="mt-2 max-w-xs text-sm text-ink-subtle">
              A curated 1,000 x 1,000 pixel wall. Claim a plot, add your artwork and link, and it
              stays there.
            </p>
            {inventory !== undefined && (
              <p className="mt-3 text-sm text-ink-muted tabular">
                {formatCount(inventory.claimedCells)} of {formatCount(inventory.totalCells)} units
                claimed
              </p>
            )}
          </div>

          <FooterColumn
            title="Explore"
            links={[
              { to: '/wall', label: 'The wall' },
              { to: '/rankings', label: 'Rankings' },
              { to: '/stats', label: 'Statistics' },
              { to: '/pricing', label: 'Pricing' },
            ]}
          />

          <FooterColumn
            title="Buy space"
            links={[
              { to: '/claim', label: 'Claim your plot' },
              { to: '/faq', label: 'How it works' },
              { to: '/content-policy', label: 'Content policy' },
              { to: '/refund-policy', label: 'Refunds' },
            ]}
          />

          <FooterColumn
            title="Legal and support"
            links={[
              { to: '/terms', label: 'Terms of service' },
              { to: '/privacy', label: 'Privacy policy' },
              { to: '/contact', label: 'Contact us' },
            ]}
          />
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-hairline pt-6 text-sm text-ink-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>
            &copy; {new Date().getFullYear()} HQPixels. Placements are paid advertising and are
            marked as such.
          </p>
          <p>
            Payments are processed by{' '}
            <a
              href="https://stripe.com"
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="text-ink-muted"
            >
              Stripe
            </a>
            . We never see or store your card details.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: ReadonlyArray<{ to: string; label: string }>;
}): React.JSX.Element {
  return (
    <nav aria-label={title}>
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-subtle">{title}</h2>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to} className="text-sm text-ink-muted no-underline hover:text-ink">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
