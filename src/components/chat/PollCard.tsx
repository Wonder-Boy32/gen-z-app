// ============================================================
// PollCard — the poll rendered inside a chat bubble (§29).
//
// It self-fetches, so it owns its own loading / error / empty states and
// must never throw inside the message list.
//
// Exact column names come from supabase/messaging_v2.sql:
//   public.polls      : id, message_id, question, options, multi,
//                       anonymous, quiz, correct_option, closes_at, created_at
//   public.poll_votes : poll_id, user_id, option_id, created_at
//
// Aggregates come from supabase/messaging_v3.sql:
//   public.poll_results(p_poll uuid) -> (option_id text, votes int, voters uuid[])
//   `voters` is deliberately NULL for anonymous polls, and poll_votes RLS
//   only lets a voter read their OWN row — which is what keeps an
//   anonymous poll anonymous. Never fetch profiles here.
//
// Colours: `fg` / `bg` are supplied by the parent bubble, so this file
// hardcodes no palette. `fg` is used for text, and a translucent
// version of `fg` for the bar track/fill, so it stays legible on either
// bubble colour.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, type } from '../../theme';
import { supabase } from '../../supabase/client';
import { friendlyError } from '../../utils/friendlyError';

type Props = {
  pollId: string;
  messageId: string;
  isMine: boolean;
  fg: string;
  bg: string;
};

/** A row of public.polls, as much of it as this card needs. */
interface PollRow {
  id: string;
  message_id: string;
  question: string;
  options: unknown; // jsonb — shape varies, see normalizeOptions()
  multi: boolean;
  anonymous: boolean;
  quiz: boolean;
  correct_option: string | null;
  closes_at: string | null;
  created_at: string;
}

/** A row of poll_results(). */
interface PollResultRow {
  option_id: string;
  votes: number;
  voters: string[] | null;
}

interface PollOption {
  id: string;
  label: string;
}

// ------------------------------------------------------------------
// Defensive helpers — the client gets `any` back from the untyped
// Supabase client, so everything is narrowed explicitly.
// ------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toPollRow(value: unknown): PollRow | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const question = str(raw.question);
  const id = str(raw.id);
  if (!id || question === null) return null;
  return {
    id,
    message_id: str(raw.message_id) ?? '',
    question,
    options: raw.options,
    multi: bool(raw.multi),
    anonymous: bool(raw.anonymous),
    quiz: bool(raw.quiz),
    correct_option: str(raw.correct_option),
    closes_at: str(raw.closes_at),
    created_at: str(raw.created_at) ?? '',
  };
}

/**
 * `polls.options` is jsonb and has been written in more than one shape.
 * Handle both:
 *   A) [{ id: 'o1', label: 'Yes' }, …]  — what messaging/api.ts writes
 *   B) ['Yes', 'No']                    — a plain string array
 * For (B) the string doubles as the option id, because that is the only
 * value a vote row could have stored in `option_id`.
 */
function normalizeOptions(raw: unknown): PollOption[] {
  if (!Array.isArray(raw)) return [];
  const out: PollOption[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry === 'string') {
      const label = entry.trim();
      if (label.length === 0) return;
      out.push({ id: label, label });
      return;
    }
    const rec = asRecord(entry);
    if (!rec) return;
    const label = str(rec.label) ?? str(rec.text) ?? str(rec.title);
    if (label === null || label.trim().length === 0) return;
    out.push({ id: str(rec.id) ?? String(index + 1), label: label.trim() });
  });
  return out;
}

function toResultRows(value: unknown): PollResultRow[] {
  if (!Array.isArray(value)) return [];
  const out: PollResultRow[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const optionId = str(rec.option_id);
    if (optionId === null) continue;
    const votersRaw = rec.voters;
    let voters: string[] | null = null;
    if (Array.isArray(votersRaw)) {
      voters = votersRaw.filter((v): v is string => typeof v === 'string');
    }
    out.push({ option_id: optionId, votes: num(rec.votes), voters });
  }
  return out;
}

/** Supabase/PostgREST error shapes are `any`; narrow to a code + message. */
function errorCode(error: unknown): string | null {
  const rec = asRecord(error);
  return rec ? str(rec.code) : null;
}

function errorMessage(error: unknown): string | null {
  const rec = asRecord(error);
  if (!rec) return null;
  return str(rec.message) ?? str(rec.details) ?? str(rec.hint);
}

const UNIQUE_VIOLATION = '23505';

/** `#rrggbb` / `#rgb` / `#rrggbbaa` / `rgb(a)(…)` → the same colour at `alpha`. */
function withAlpha(color: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const hex = color.trim();

  if (hex.startsWith('#')) {
    const body = hex.slice(1);
    let r: number;
    let g: number;
    let b: number;
    if (body.length === 3 || body.length === 4) {
      r = parseInt(body[0] + body[0], 16);
      g = parseInt(body[1] + body[1], 16);
      b = parseInt(body[2] + body[2], 16);
    } else if (body.length === 6 || body.length === 8) {
      r = parseInt(body.slice(0, 2), 16);
      g = parseInt(body.slice(2, 4), 16);
      b = parseInt(body.slice(4, 6), 16);
    } else {
      return color;
    }
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return color;
    return `rgba(${r}, ${g}, ${b}, ${clamped})`;
  }

  if (hex.startsWith('rgba(') || hex.startsWith('rgb(')) {
    const inner = hex.slice(hex.indexOf('(') + 1, hex.lastIndexOf(')'));
    const parts = inner.split(',').map((p) => p.trim());
    if (parts.length >= 3) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${clamped})`;
    }
  }

  // Unknown format (e.g. a named colour) — leave it alone rather than guess.
  return color;
}

export default function PollCard({ pollId, messageId, isMine, fg, bg }: Props) {
  const [poll, setPoll] = useState<PollRow | null>(null);
  const [results, setResults] = useState<PollResultRow[]>([]);
  const [myVotes, setMyVotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);

  const options = useMemo(() => normalizeOptions(poll?.options), [poll?.options]);

  const closed = useMemo(() => {
    if (!poll?.closes_at) return false;
    const at = Date.parse(poll.closes_at);
    if (Number.isNaN(at)) return false;
    return at <= Date.now();
  }, [poll?.closes_at]);

  // ---- results -----------------------------------------------------
  const fetchResults = useCallback(async (): Promise<PollResultRow[]> => {
    const { data, error } = await supabase.rpc('poll_results', { p_poll: pollId });
    if (error) {
      // Degrade to "every option has 0 votes" instead of crashing the list.
      return [];
    }
    return toResultRows(data);
  }, [pollId]);

  const fetchMyVotes = useCallback(async (): Promise<string[]> => {
    // RLS on poll_votes only exposes the caller's own rows — so this is
    // safe for anonymous polls too, and never reveals anyone else.
    const { data, error } = await supabase
      .from('poll_votes')
      .select('option_id')
      .eq('poll_id', pollId);
    if (error || !Array.isArray(data)) return [];
    const ids: string[] = [];
    for (const row of data as unknown[]) {
      const optionId = str(asRecord(row)?.option_id);
      if (optionId !== null) ids.push(optionId);
    }
    return ids;
  }, [pollId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data, error } = await supabase.from('polls').select('*').eq('id', pollId).maybeSingle();
        if (cancelled) return;

        if (error) {
          setLoadError(errorMessage(error) ?? 'Could not load this poll.');
          setPoll(null);
          setResults([]);
          return;
        }

        const row = toPollRow(data);
        if (!row) {
          setPoll(null);
          setResults([]);
          setLoadError('This poll is no longer available.');
          return;
        }

        const [rows, mine] = await Promise.all([fetchResults(), fetchMyVotes()]);
        if (cancelled) return;
        setPoll(row);
        setResults(rows);
        setMyVotes(mine);
      } catch (e: unknown) {
        if (cancelled) return;
        setLoadError(friendlyError(e, 'Could not load this poll.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pollId, fetchResults, fetchMyVotes]);

  const refresh = useCallback(async () => {
    const [rows, mine] = await Promise.all([fetchResults(), fetchMyVotes()]);
    setResults(rows);
    setMyVotes(mine);
  }, [fetchResults, fetchMyVotes]);

  // ---- voting ------------------------------------------------------
  const castVote = useCallback(
    async (option: PollOption) => {
      if (closed || voting || !poll) return;
      setVoteError(null);

      const alreadyMine = myVotes.includes(option.id);
      setVoting(true);
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id ?? null;
        if (!userId) {
          setVoteError('Sign in again to vote.');
          return;
        }

        // Every required column is supplied: the app's client wrapper
        // rejects filter-less writes, and poll_votes' RLS demands
        // user_id = auth.uid().
        const { error } = await supabase
          .from('poll_votes')
          .insert({ poll_id: pollId, user_id: userId, option_id: option.id });

        if (error) {
          const code = errorCode(error);
          if (code !== UNIQUE_VIOLATION) {
            // Anything that is not "you already voted" is a real failure.
            setVoteError(errorMessage(error) ?? 'Your vote was not saved.');
            return;
          }
          // 23505 = duplicate (poll_id, user_id, option_id). Not an error:
          // the vote is already recorded.
        }

        if (!alreadyMine) setMyVotes((prev) => [...prev, option.id]);
        await refresh();
      } catch (e: unknown) {
        setVoteError(friendlyError(e, 'Your vote was not saved.'));
      } finally {
        setVoting(false);
      }
    },
    [closed, voting, poll, myVotes, pollId, refresh]
  );

  // ---- derived numbers --------------------------------------------
  const countFor = useCallback(
    (optionId: string): number => {
      const hit = results.find((r) => r.option_id === optionId);
      return hit ? hit.votes : 0;
    },
    [results]
  );

  const votersFor = useCallback(
    (optionId: string): string[] | null => {
      if (poll?.anonymous) return null; // anonymous: counts only, never names
      const hit = results.find((r) => r.option_id === optionId);
      return hit?.voters ?? null;
    },
    [results, poll?.anonymous]
  );

  const maxVotes = useMemo(
    () => Math.max(1, ...options.map((o) => countFor(o.id)), 0),
    [options, countFor]
  );

  const totalVotes = useMemo(
    () => results.reduce((sum, r) => sum + (Number.isFinite(r.votes) ? r.votes : 0), 0),
    [results]
  );

  const trackColor = withAlpha(fg, 0.12);
  const fillColor = withAlpha(fg, 0.3);
  const dividerColor = withAlpha(fg, 0.16);
  const mutedFg = withAlpha(fg, 0.62);
  const faintFg = withAlpha(fg, 0.42);

  const a11yFg = `poll-${messageId}`;

  if (loading) {
    return (
      <View style={styles.stateRow} testID={a11yFg}>
        <ActivityIndicator size="small" color={fg} />
        <Text style={[styles.stateText, { color: mutedFg }]}>Loading poll…</Text>
      </View>
    );
  }

  if (loadError !== null || !poll) {
    return (
      <View style={styles.stateBlock} testID={a11yFg}>
        <Text style={[styles.stateText, { color: mutedFg }]}>{loadError ?? 'Poll unavailable.'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap} testID={a11yFg}>
      <Text style={[styles.question, { color: fg }]} accessibilityRole="text">
        {poll.question}
      </Text>

      <View style={[styles.metaRow, { borderBottomColor: dividerColor }]}>
        <Text style={[styles.meta, { color: faintFg }]}>
          {poll.multi ? 'Multiple answers' : 'One answer'}
          {poll.anonymous ? ' · Anonymous' : ''}
        </Text>
        <Text style={[styles.meta, { color: faintFg }]}>
          {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
        </Text>
      </View>

      {options.length === 0 ? (
        <Text style={[styles.stateText, { color: mutedFg, marginTop: spacing.sm }]}>
          This poll has no options.
        </Text>
      ) : (
        options.map((option, index) => {
          const votes = countFor(option.id);
          const ratio = maxVotes > 0 ? votes / maxVotes : 0;
          const width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%` as const;
          const selected = myVotes.includes(option.id);
          const voters = votersFor(option.id);
          const disabled = closed || voting;

          return (
            <Pressable
              key={`${option.id}-${index}`}
              onPress={() => void castVote(option)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Vote for ${option.label}`}
              accessibilityState={{ disabled, selected }}
              style={[styles.option, { backgroundColor: bg, borderColor: dividerColor }]}
            >
              {/* proportional fill behind the row */}
              <View
                pointerEvents="none"
                style={[styles.barTrack, { backgroundColor: trackColor }]}
              />
              <View pointerEvents="none" style={[styles.barFill, { width, backgroundColor: fillColor }]} />

              <View style={styles.optionInner}>
                <Text style={[styles.optionLabel, { color: fg }]} numberOfLines={2}>
                  {selected ? '✓ ' : ''}
                  {option.label}
                </Text>
                <View style={styles.optionRight}>
                  {voters !== null && voters.length > 0 && (
                    <Text style={[styles.voters, { color: faintFg }]}>
                      {voters.length} {voters.length === 1 ? 'voter' : 'voters'}
                    </Text>
                  )}
                  <Text style={[styles.count, { color: fg }]} accessibilityLabel={`${votes} votes`}>
                    {votes}
                  </Text>
                </View>
              </View>
            </Pressable>
          );
        })
      )}

      <Text style={[styles.caption, { color: faintFg }]}>
        {closed ? 'Poll closed' : isMine ? 'Tap an option to vote · Your poll' : 'Tap an option to vote'}
      </Text>

      {voteError !== null && <Text style={[styles.caption, { color: fg }]}>{voteError}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    minWidth: 210,
    maxWidth: 320,
  },
  question: {
    ...type.heading,
    marginBottom: spacing.sm,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: spacing.xs,
    marginBottom: spacing.sm,
  },
  meta: {
    ...type.micro,
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  stateBlock: {
    paddingVertical: spacing.sm,
  },
  stateText: {
    ...type.caption,
    marginLeft: spacing.xs,
  },
  option: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginBottom: spacing.sm,
  },
  barTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  barFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  optionInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  optionLabel: {
    ...type.body,
    flexShrink: 1,
    paddingRight: spacing.sm,
  },
  optionRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  voters: {
    ...type.micro,
    marginRight: spacing.sm,
  },
  count: {
    ...type.caption,
  },
  caption: {
    ...type.caption,
    marginTop: spacing.xs,
  },
});
