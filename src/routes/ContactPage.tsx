/**
 * Contact page with abuse report form.
 *
 * The abuse report form POSTs to /api/public/report and requires a Turnstile
 * verification token. The form matches the abuseReportSchema in shared/schemas.ts.
 */

import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { MAX_ABUSE_REPORT_LENGTH } from '@shared/constants';
import { api, ApiRequestError } from '../lib/api';
import { Alert, Button, TextArea, TextField } from '../components/primitives';
import { Turnstile, resetTurnstile } from '../components/Turnstile';

type AbuseCategory =
  'malware' | 'phishing' | 'adult' | 'illegal' | 'misleading' | 'broken' | 'other';

interface FormState {
  placementId: string;
  category: AbuseCategory;
  details: string;
}

const categoryOptions: Array<{ value: AbuseCategory; label: string }> = [
  { value: 'malware', label: 'Malware or virus' },
  { value: 'phishing', label: 'Phishing or scam' },
  { value: 'adult', label: 'Adult content' },
  { value: 'illegal', label: 'Illegal content' },
  { value: 'misleading', label: 'Misleading or deceptive' },
  { value: 'broken', label: 'Broken or dead link' },
  { value: 'other', label: 'Other' },
];

export function ContactPage(): React.JSX.Element {
  const [form, setForm] = useState<FormState>({
    placementId: '',
    category: 'other',
    details: '',
  });
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setFieldErrors({});

      if (!turnstileToken) {
        setError('Please complete the verification challenge.');
        return;
      }

      // Basic UUID validation
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(form.placementId.trim())) {
        setFieldErrors({ placementId: 'Enter a valid placement ID (UUID format).' });
        return;
      }

      setSubmitting(true);

      try {
        await api.post('/api/public/report', {
          placementId: form.placementId.trim(),
          category: form.category,
          details: form.details.trim(),
          turnstileToken,
        });
        setSuccess(true);
        setForm({ placementId: '', category: 'other', details: '' });
        setTurnstileToken(null);
        resetTurnstile();
      } catch (err) {
        if (err instanceof ApiRequestError) {
          setError(err.message);
          if (err.fields) {
            setFieldErrors(err.fields);
          }
        } else {
          setError('Something went wrong. Please try again.');
        }
        resetTurnstile();
        setTurnstileToken(null);
      } finally {
        setSubmitting(false);
      }
    },
    [form, turnstileToken],
  );

  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-semibold">Contact us</h1>
      <p className="mt-2 text-ink-muted">
        We are here to help. Choose the appropriate channel below.
      </p>

      {/* --- contact channels --------------------------------------------- */}
      <section aria-labelledby="channels-heading" className="mt-10">
        <h2 id="channels-heading" className="text-lg font-semibold">
          Email contacts
        </h2>
        <dl className="mt-4 space-y-4">
          <div className="rounded-lg border border-hairline bg-surface-raised p-4">
            <dt className="font-medium">General inquiries</dt>
            <dd className="mt-1 text-sm text-ink-muted">
              <a href="mailto:hello@hqpixels.com" className="text-cyan hover:underline">
                hello@hqpixels.com
              </a>
              <p className="mt-1">
                Questions about the service, your account, or placements. Include your placement ID
                or the email address you used to sign in.
              </p>
            </dd>
          </div>

          <div className="rounded-lg border border-hairline bg-surface-raised p-4">
            <dt className="font-medium">Abuse reports</dt>
            <dd className="mt-1 text-sm text-ink-muted">
              <a href="mailto:abuse@hqpixels.com" className="text-cyan hover:underline">
                abuse@hqpixels.com
              </a>
              <p className="mt-1">
                Report content that violates our{' '}
                <Link to="/content-policy" className="text-cyan hover:underline">
                  content policy
                </Link>
                . You can also use the form below.
              </p>
            </dd>
          </div>

          <div className="rounded-lg border border-hairline bg-surface-raised p-4">
            <dt className="font-medium">Security</dt>
            <dd className="mt-1 text-sm text-ink-muted">
              <a href="mailto:security@hqpixels.com" className="text-cyan hover:underline">
                security@hqpixels.com
              </a>
              <p className="mt-1">
                Report security vulnerabilities or concerns. We take these seriously and will
                respond promptly.
              </p>
            </dd>
          </div>
        </dl>

        <p className="mt-4 text-sm text-ink-subtle">
          Expected response time: 1–2 business days for general inquiries, same day for urgent
          security matters.
        </p>
      </section>

      {/* --- abuse report form -------------------------------------------- */}
      <section aria-labelledby="report-heading" className="mt-12">
        <h2 id="report-heading" className="text-lg font-semibold">
          Report a placement
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          Use this form to report a placement that may violate our content policy. You will need the
          placement ID, which you can find in your{' '}
          <Link to="/dashboard" className="text-cyan hover:underline">
            dashboard
          </Link>{' '}
          or in the URL when viewing a placement detail page.
        </p>

        {success ? (
          <Alert tone="success" title="Report submitted" className="mt-6">
            <p className="text-sm">
              Thank you for your report. We will review it and take appropriate action. You may not
              receive a direct response, but we read every report.
            </p>
          </Alert>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 space-y-4">
            {error && (
              <Alert tone="danger" title="Could not submit report">
                {error}
              </Alert>
            )}

            <TextField
              label="Placement ID"
              name="placementId"
              value={form.placementId}
              onChange={(e) => setForm((prev) => ({ ...prev, placementId: e.target.value }))}
              placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
              required
              error={fieldErrors['placementId']}
              hint="The UUID of the placement you are reporting"
            />

            <div>
              <label htmlFor="category" className="field-label">
                Category
              </label>
              <select
                id="category"
                name="category"
                value={form.category}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, category: e.target.value as AbuseCategory }))
                }
                className="field-input"
                required
              >
                {categoryOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <TextArea
              label="Details"
              name="details"
              value={form.details}
              onChange={(e) => setForm((prev) => ({ ...prev, details: e.target.value }))}
              placeholder="Describe what you observed and why you believe it violates our policies."
              rows={4}
              maxLength={MAX_ABUSE_REPORT_LENGTH}
              counter={{ current: form.details.length, max: MAX_ABUSE_REPORT_LENGTH }}
              error={fieldErrors['details']}
            />

            <Turnstile action="abuse-report" onToken={setTurnstileToken} className="mt-4" />

            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              loadingLabel="Submitting"
              disabled={!turnstileToken}
            >
              Submit report
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}

export default ContactPage;
