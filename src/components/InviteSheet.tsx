import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import {
  ensureMyInviteCode,
  getMyInviteStats,
  redeemInvite,
  shareInvite,
} from '../utils/invites';

/**
 * InviteSheet — one sheet, both halves of the invite loop.
 *
 * WHY BOTH HALVES IN ONE PLACE
 *
 * The inviter needs to hand out a code; the invitee needs to enter one. Splitting
 * them across two surfaces means the entry point has to be somewhere in the
 * sign-up flow, which is a step every new user walks through whether or not they
 * were invited. Putting the "have a code?" field behind the same sheet keeps
 * sign-up untouched for the majority and still leaves the invitee a manual path
 * that always works, even when a deep link fails.
 *
 * The count is shown to the inviter on purpose. The feed is empty because there
 * are no people; being able to see who actually arrived is the only way to tell
 * whether inviting is working, and a number that moves is what makes it worth
 * doing again.
 */

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Fires after a successful redemption, so the caller can refresh. */
  onRedeemed?: (inviter: string | null) => void;
};

export default function InviteSheet({ visible, onClose, onRedeemed }: Props) {
  const [code, setCode] = useState<string | null>(null);
  const [joined, setJoined] = useState(0);
  const [loading, setLoading] = useState(true);

  const [copied, setCopied] = useState(false);
  const [entry, setEntry] = useState('');
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryMsg, setEntryMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Load (and on first ever open, allocate) the code, then read the count.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setLoading(true);
    setEntryMsg(null);
    setCopied(false);

    (async () => {
      const mine = await ensureMyInviteCode();
      if (!alive) return;
      setCode(mine);
      const stats = await getMyInviteStats();
      if (!alive) return;
      setJoined(stats.joined);
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [visible]);

  const onCopy = useCallback(async () => {
    if (!code) return;
    try {
      await Clipboard.setStringAsync(code);
      setCopied(true);
      // Revert the label so a second copy still gives feedback.
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can fail on some Android builds. Sharing still works, so this
      // is not worth an error banner — but it must not look like it succeeded.
      setCopied(false);
    }
  }, [code]);

  const onShare = useCallback(async () => {
    if (!code) return;
    await shareInvite(code);
    // The count only changes when someone else signs up, so re-reading here
    // would just be noise. Left as-is deliberately.
  }, [code]);

  const onRedeem = useCallback(async () => {
    if (entryBusy) return;
    setEntryBusy(true);
    setEntryMsg(null);
    const res = await redeemInvite(entry);
    setEntryBusy(false);
    setEntryMsg({ ok: res.ok, text: res.message });
    if (res.ok) {
      setEntry('');
      onRedeemed?.(res.inviter ?? null);
    }
  }, [entry, entryBusy, onRedeemed]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />

          <View style={styles.header}>
            <Text style={styles.title}>Invite friends</Text>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </Pressable>
          </View>

          <Text style={styles.blurb}>
            Gen Z is quiet until people you know are here. Share your code — every post stays
            up for 7 days, then it is gone for good.
          </Text>

          {/* ---------- inviter half ---------- */}
          {loading ? (
            <View style={styles.codeBox}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : code ? (
            <>
              <View style={styles.codeBox}>
                <Text style={styles.codeLabel}>YOUR CODE</Text>
                <Text style={styles.code} selectable>
                  {code}
                </Text>
                <Text style={styles.joined}>
                  {joined === 0
                    ? 'Nobody has joined with it yet'
                    : `${joined} ${joined === 1 ? 'person' : 'people'} joined with it`}
                </Text>
              </View>

              <View style={styles.actions}>
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={onCopy}>
                  <Ionicons
                    name={copied ? 'checkmark' : 'copy-outline'}
                    size={17}
                    color={copied ? colors.accent : colors.text}
                  />
                  <Text style={[styles.btnText, copied && styles.btnTextAccent]}>
                    {copied ? 'Copied' : 'Copy'}
                  </Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onShare}>
                  <Ionicons name="share-outline" size={17} color="#0B1120" />
                  <Text style={styles.btnTextDark}>Share</Text>
                </Pressable>
              </View>
            </>
          ) : (
            // A code we could not fetch is a real failure worth naming, not a
            // spinner that never resolves.
            <View style={styles.codeBox}>
              <Text style={styles.joined}>
                Could not get your code just now. Check your connection and reopen this.
              </Text>
            </View>
          )}

          {/* ---------- invitee half ---------- */}
          <View style={styles.divider} />
          <Text style={styles.entryLabel}>Got a code from someone?</Text>
          <View style={styles.entryRow}>
            <TextInput
              style={styles.entryInput}
              placeholder="ABC123"
              placeholderTextColor={colors.textFaint}
              value={entry}
              onChangeText={(t) => {
                // Codes are uppercase and 6 chars; folding as they type means the
                // field cannot be filled with something the server will reject
                // only because of case.
                setEntry(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
                setEntryMsg(null);
              }}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={6}
            />
            <Pressable
              style={[styles.btn, styles.btnGhost, entry.trim().length < 6 && styles.btnDisabled]}
              onPress={onRedeem}
              disabled={entryBusy || entry.trim().length < 6}
            >
              {entryBusy ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Text style={styles.btnText}>Enter</Text>
              )}
            </Pressable>
          </View>

          {!!entryMsg && (
            <Text style={[styles.entryMsg, entryMsg.ok ? styles.entryOk : styles.entryBad]}>
              {entryMsg.text}
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  backdropFill: { flex: 1 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 20,
    paddingBottom: TOP_INSET + 24,
    paddingTop: 10,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 14,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 19, fontWeight: '800' },
  closeBtn: { padding: 4 },
  blurb: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  codeBox: {
    marginTop: 16,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 18,
    alignItems: 'center',
  },
  codeLabel: { color: colors.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.6 },
  code: {
    color: colors.accent,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 5,
    marginTop: 8,
  },
  joined: { color: colors.textMuted, fontSize: 12, fontWeight: '600', marginTop: 9, textAlign: 'center', paddingHorizontal: 16 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: {
    flex: 1,
    height: 46,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderWidth: 1,
  },
  btnGhost: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  btnTextAccent: { color: colors.accent },
  btnTextDark: { color: '#0B1120', fontSize: 14, fontWeight: '800' },
  divider: { height: 1, backgroundColor: colors.border, marginTop: 22, marginBottom: 16 },
  entryLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '700', marginBottom: 9 },
  entryRow: { flexDirection: 'row', gap: 10 },
  entryInput: {
    flex: 1,
    height: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 14,
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 3,
  },
  entryMsg: { fontSize: 12.5, fontWeight: '700', marginTop: 10, lineHeight: 18 },
  entryOk: { color: colors.accent },
  entryBad: { color: colors.danger },
});
