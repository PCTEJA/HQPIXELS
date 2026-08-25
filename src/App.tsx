/**
 * Routing and the page shell.
 *
 * Route-level code splitting is deliberate and load-bearing for the performance
 * budget: the landing page must not download PixiJS, the claim wizard, Stripe's
 * script, or the admin surface. Only `/` and its immediate chrome are in the
 * entry chunk.
 */

import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LandingPage } from './routes/LandingPage';
import { PageSpinner } from './components/PageSpinner';
import { NotFoundPage } from './routes/NotFoundPage';
import { useManifestVersionWatcher } from './lib/queries';
import { beacon } from './lib/api';

// --- lazy routes -------------------------------------------------------------
const WallPage = lazy(() => import('./routes/WallPage'));
const ClaimPage = lazy(() => import('./routes/ClaimPage'));
const ClaimSuccessPage = lazy(() => import('./routes/ClaimSuccessPage'));
const ClaimCancelledPage = lazy(() => import('./routes/ClaimCancelledPage'));
const RankingsPage = lazy(() => import('./routes/RankingsPage'));
const StatsPage = lazy(() => import('./routes/StatsPage'));
const DashboardPage = lazy(() => import('./routes/DashboardPage'));
const PlacementDetailPage = lazy(() => import('./routes/PlacementDetailPage'));
const AdminPage = lazy(() => import('./routes/AdminPage'));
const PricingPage = lazy(() => import('./routes/PricingPage'));
const LegalPage = lazy(() => import('./routes/LegalPage'));
const ContactPage = lazy(() => import('./routes/ContactPage'));
const FaqPage = lazy(() => import('./routes/FaqPage'));

/**
 * Page-view beacon + scroll reset on navigation.
 *
 * The counter is incremented here rather than server-side because the HTML
 * document is served from the edge cache (so the Worker never sees it). That
 * trade-off is why the number is labelled "Total page views" and never
 * "visitors" — see the note on /stats.
 */
function useNavigationEffects(): void {
  const location = useLocation();

  useEffect(() => {
    // Reset scroll on a route change, but not on a hash link within a page.
    if (location.hash === '') window.scrollTo({ top: 0, behavior: 'auto' });

    // Never count the dashboard, admin or checkout return pages: they are
    // private and would inflate a public figure with private activity.
    const excluded = ['/dashboard', '/admin', '/claim/success', '/claim/cancelled'];
    if (excluded.some((prefix) => location.pathname.startsWith(prefix))) return;

    beacon('/api/public/view', { path: location.pathname });
  }, [location.pathname, location.hash]);
}

export function App(): React.JSX.Element {
  useNavigationEffects();
  // One polling loop for the whole app, mounted here so it survives navigation
  // between the landing page and the wall without restarting.
  useManifestVersionWatcher();

  return (
    <Layout>
      <Suspense fallback={<PageSpinner />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/wall" element={<WallPage />} />

          <Route path="/claim" element={<ClaimPage />} />
          <Route path="/claim/success" element={<ClaimSuccessPage />} />
          <Route path="/claim/cancelled" element={<ClaimCancelledPage />} />
          {/* A buyer returning to an in-progress claim. */}
          <Route path="/claim/resume" element={<ClaimPage />} />

          <Route path="/rankings" element={<RankingsPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/pricing" element={<PricingPage />} />

          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/dashboard/placements/:placementId" element={<PlacementDetailPage />} />

          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/:tab" element={<AdminPage />} />

          <Route path="/faq" element={<FaqPage />} />
          <Route path="/contact" element={<ContactPage />} />

          {/* One component renders all four policy documents, from one source of
              truth, so they cannot drift apart in tone or terminology. */}
          <Route path="/terms" element={<LegalPage document="terms" />} />
          <Route path="/privacy" element={<LegalPage document="privacy" />} />
          <Route path="/content-policy" element={<LegalPage document="content-policy" />} />
          <Route path="/refund-policy" element={<LegalPage document="refund-policy" />} />

          {/* Historical/alternate paths people will guess. */}
          <Route path="/buy" element={<Navigate to="/claim" replace />} />
          <Route path="/leaderboard" element={<Navigate to="/rankings" replace />} />

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
