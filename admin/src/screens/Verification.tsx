import { useState } from 'react';
import { api, VerificationRequestRow } from '../lib/api';
import {
  Page,
  Stat,
  Card,
  Spinner,
  Empty,
  Avatar,
  useLoad,
  useToast,
  fmtTime,
  ReasonPrompt,
} from '../components/UI';

type Filter = 'pending' | 'approved' | 'rejected' | null;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: null, label: 'All' },
];

// Verification is EARNED, not bought — see supabase/verification_requests.sql.
// This screen is the human half of that sentence: it is the only place an
// application can be decided, and approving here is the only thing that sets
// profiles.verified through the review path.
export default function Verification() {
  const { toast } = useToast();
  const [status, setStatus] = useState<Filter>('pending');
  const l = useLoad(() => api.verificationQueue(status), [status]);
  const [review, setReview] = useState<{ row: VerificationRequestRow; approve: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = l.data ?? [];

  const apply = async (row: VerificationRequestRow, approve: boolean, note: string) => {
    setBusyId(row.id);
    try {
      const res = await api.verificationReview(row.id, approve, note);
      // The RPC reports refusals inline (already reviewed, not found, missing
      // rejection reason, permission_denied) rather than throwing, so surface
      // them explicitly instead of claiming a decision that did not happen.
      if (res && res.ok === false) {
        toast(res.error ?? 'Could not update that application', 'error');
        return;
      }
      toast(
        approve
          ? `Verified @${row.username ?? 'applicant'}`
          : `Application rejected for @${row.username ?? 'applicant'}`
      );
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Page
      title="Verification"
      sub="Applications for the verified badge. Approving grants the badge — this is the only review path."
    >
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <Stat
          label={status === 'pending' ? 'Awaiting review' : `${status ?? 'All'} shown`}
          value={rows.length}
          tone={status === 'pending' && rows.length > 0 ? 'accent' : undefined}
        />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button
            key={f.label}
            className={`btn sm${status === f.key ? '' : ' ghost'}`}
            onClick={() => setStatus(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {l.loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          text={
            status === 'pending'
              ? 'No applications waiting for review.'
              : 'Nothing here for this filter.'
          }
        />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Why they qualify</th>
                  <th>Links</th>
                  <th>Submitted</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Avatar name={r.username ?? r.display_name} size={26} />
                        <div>
                          <div>@{r.username ?? 'unknown'}</div>
                          {/* The applicant may type a different display name than
                              the account they are applying from — show both so a
                              reviewer can see when they disagree. */}
                          {r.display_name && r.display_name !== r.username && (
                            <div className="muted" style={{ fontSize: 12 }}>
                              as “{r.display_name}”
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ maxWidth: 380, whiteSpace: 'pre-wrap' }}>{r.reason}</td>
                    <td className="muted" style={{ maxWidth: 200, wordBreak: 'break-word' }}>
                      {r.links ? r.links : '—'}
                    </td>
                    <td className="time">{fmtTime(r.created_at)}</td>
                    <td>
                      {/* Plain markup on purpose: no `.pill` class is defined in
                          the admin stylesheet, and inventing one would render as
                          unstyled text. */}
                      <span style={{ fontWeight: r.status === 'pending' ? 700 : 400 }}>
                        {r.status}
                      </span>
                    </td>
                    <td>
                      {r.status === 'pending' ? (
                        <div
                          style={{
                            display: 'flex',
                            gap: 6,
                            flexWrap: 'wrap',
                            justifyContent: 'flex-end',
                          }}
                        >
                          <button
                            className="btn sm"
                            disabled={busyId === r.id}
                            onClick={() => setReview({ row: r, approve: true })}
                          >
                            {busyId === r.id ? 'Working…' : 'Approve'}
                          </button>
                          <button
                            className="btn sm danger"
                            disabled={busyId === r.id}
                            onClick={() => setReview({ row: r, approve: false })}
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {r.review_note ? `“${r.review_note}”` : 'decided'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="muted" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.6 }}>
        Approving sets the verified badge on the applicant&apos;s profile in the same
        transaction, so the queue and the badge cannot disagree. Rejecting does{' '}
        <b>not</b> remove a badge the account already earned, and the reason you give is
        shown to the applicant word for word — so write something they can act on. A
        rejection requires a reason; a decision cannot be changed afterwards from this
        screen, and every decision is written to the audit log.
      </p>

      {review && (
        <ReasonPrompt
          title={review.approve ? 'Approve this application' : 'Reject this application'}
          message={
            review.approve
              ? `Grant the verified badge to @${review.row.username ?? 'this applicant'}? Their stated reason: “${review.row.reason.slice(0, 240)}”`
              : `Reject the application from @${review.row.username ?? 'this applicant'}? Give a real reason — they see it exactly as written.`
          }
          confirmLabel={review.approve ? 'Approve & verify' : 'Reject application'}
          danger={!review.approve}
          onConfirm={(reason) => apply(review.row, review.approve, reason)}
          onClose={() => setReview(null)}
        />
      )}
    </Page>
  );
}
