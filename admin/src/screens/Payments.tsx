import { useState } from 'react';
import { api, GenZPlusPaymentRow } from '../lib/api';
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

// The admin app has no money formatter yet. Kept local and Hermes/ICU-free so it
// renders identically everywhere.
function naira(kobo: number | string | null): string {
  const n = Math.max(0, Math.round(Number(kobo ?? 0) / 100));
  return '₦' + n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export default function Payments() {
  const { toast } = useToast();
  const l = useLoad(() => api.genzplusPending(), []);
  const [review, setReview] = useState<{ row: GenZPlusPaymentRow; approve: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = l.data ?? [];
  const pendingKobo = rows.reduce((sum, r) => sum + Number(r.amount_kobo ?? 0), 0);

  const apply = async (row: GenZPlusPaymentRow, approve: boolean, note: string) => {
    setBusyId(row.id);
    try {
      const res = await api.genzplusReview(row.id, approve, note);
      // The RPC reports refusals inline (already reviewed, activation refused,
      // permission_denied) rather than throwing, so surface them explicitly
      // instead of claiming a success that did not happen.
      if (res && res.ok === false) {
        toast(res.error ?? 'Could not update that payment', 'error');
        return;
      }
      toast(
        approve
          ? `GenZ+ activated for @${row.username ?? 'member'}`
          : `Payment rejected for @${row.username ?? 'member'}`
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
      title="GenZ+ Payments"
      sub="Confirm the OPay transfers members submit. Approving is the only thing that grants premium."
    >
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <Stat
          label="Awaiting review"
          value={rows.length}
          tone={rows.length > 0 ? 'accent' : undefined}
        />
        <Stat label="Value pending" value={naira(pendingKobo)} tone="green" />
      </div>

      {l.loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty text="No payments waiting for review." />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Reference</th>
                  <th>Amount</th>
                  <th>Note</th>
                  <th>Submitted</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Avatar name={r.username} size={26} />
                        <span>@{r.username ?? 'unknown'}</span>
                      </div>
                    </td>
                    <td style={{ fontWeight: 700, letterSpacing: 0.4 }}>{r.reference}</td>
                    <td>{naira(r.amount_kobo)}</td>
                    <td className="muted">{r.note ? `“${r.note}”` : '—'}</td>
                    <td className="time">{fmtTime(r.created_at)}</td>
                    <td>
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
                          {busyId === r.id ? 'Working…' : 'Confirm payment'}
                        </button>
                        <button
                          className="btn sm danger"
                          disabled={busyId === r.id}
                          onClick={() => setReview({ row: r, approve: false })}
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="muted" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.6 }}>
        Confirming activates GenZ+ for 2 months — counted from today, or from the member&apos;s
        existing expiry when that is still in the future, so nobody loses days by paying early.
        Check the transfer in your OPay app <b>before</b> confirming: this is the step that
        grants premium, and the member is told GenZ+ activated. A claim is refused if it was
        already reviewed, or if activation is refused. Every decision is written to the audit log.
      </p>

      {review && (
        <ReasonPrompt
          title={review.approve ? 'Confirm this payment' : 'Reject this payment'}
          message={
            review.approve
              ? `Activate GenZ+ for @${review.row.username ?? 'this member'} (${naira(
                  review.row.amount_kobo
                )}), reference ${review.row.reference}? Confirm you have seen this transfer land in your OPay account.`
              : `Reject the claim from @${review.row.username ?? 'this member'} for ${naira(
                  review.row.amount_kobo
                )}? They will see this reason, and the reference is released so they can submit it again.`
          }
          confirmLabel={review.approve ? 'Activate GenZ+' : 'Reject payment'}
          danger={!review.approve}
          onConfirm={(reason) => apply(review.row, review.approve, reason)}
          onClose={() => setReview(null)}
        />
      )}
    </Page>
  );
}
