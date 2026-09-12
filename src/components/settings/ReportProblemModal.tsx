import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../../supabase/client';
import { colors, radius, shadows } from '../../theme';
import { copyToClipboard } from '../../utils/clipboard';
import Icon from '../ui/Icon';
import Button from '../Button';

/** Where problem reports land. Shown in the UI so nobody has to hunt for it. */
export const SUPPORT_EMAIL = 'genz111145@gmail.com';
const APP_VERSION = '0.1.0';

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'bug', label: 'Something is broken' },
  { key: 'abuse', label: 'Harassment or abuse' },
  { key: 'content', label: 'Harmful content' },
  { key: 'account', label: 'Login or account' },
  { key: 'idea', label: 'Idea or feedback' },
  { key: 'other', label: 'Something else' },
];

const MIN_MESSAGE = 10;

function deviceLabel(): string {
  return `${Platform.OS} ${String(Platform.Version)} - app ${APP_VERSION}`;
}

type Props = {
  visible: boolean;
  onClose: () => void;
  accountEmail?: string;
  username?: string;
  userId?: string;
};

export default function ReportProblemModal({ visible, onClose, accountEmail, username, userId }: Props) {
  const [category, setCategory] = useState('bug');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (visible) {
      setCategory('bug');
      setMessage('');
      setContact(accountEmail ?? '');
      setCopied(false);
      setSending(false);
    }
  }, [visible, accountEmail]);

  const ready = message.trim().length >= MIN_MESSAGE;
  const label = CATEGORIES.find((c) => c.key === category)?.label ?? 'Something else';

  const buildSubject = () => `Gen Z report - ${label}${username ? ` (@${username})` : ''}`;

  const buildBody = () =>
    [
      `Category: ${label}`,
      `Account: @${username ?? 'unknown'}${userId ? ` (${userId})` : ''}`,
      `Reply to: ${contact.trim() || accountEmail || 'not provided'}`,
      '',
      'What happened:',
      message.trim(),
      '',
      '---',
      `Device: ${deviceLabel()}`,
      `Sent: ${new Date().toISOString()}`,
    ].join('\n');

  /** Best-effort in-app record. A missing table must never block the report. */
  const logReport = async () => {
    try {
      await supabase.from('support_reports').insert({
        user_id: userId ?? null,
        category,
        message: message.trim(),
        contact_email: contact.trim() || accountEmail || null,
        username: username ?? null,
        device: deviceLabel(),
        app_version: APP_VERSION,
      });
    } catch {
      // support_reports not created yet - the email path still goes out
    }
  };

  const send = async () => {
    if (!ready || sending) return;
    setSending(true);
    const body = buildBody();
    await logReport();
    const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(buildSubject())}&body=${encodeURIComponent(body)}`;
    try {
      await Linking.openURL(url);
      setSending(false);
      onClose();
    } catch {
      const ok = await copyToClipboard(`${buildSubject()}\n\n${body}`);
      setSending(false);
      Alert.alert(
        'No mail app found',
        ok
          ? `Your report was copied to the clipboard. Send it to ${SUPPORT_EMAIL}.`
          : `Could not open a mail app. Please email ${SUPPORT_EMAIL} directly.`
      );
    }
  };

  const copyReport = async () => {
    const ok = await copyToClipboard(`${buildSubject()}\n\n${buildBody()}`);
    setCopied(ok);
    if (!ok) Alert.alert('Copy unavailable', `Please email ${SUPPORT_EMAIL} directly.`);
  };

  const copyEmail = async () => {
    const ok = await copyToClipboard(SUPPORT_EMAIL);
    if (!ok) Alert.alert('Support email', SUPPORT_EMAIL);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Report a problem</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Icon name="close-outline" size={24} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text style={styles.lead}>
              Tell us what went wrong. Reports go straight to the team and can be sent from your own mail app.
            </Text>

            <Text style={styles.label}>What is this about?</Text>
            <View style={styles.chips}>
              {CATEGORIES.map((c) => {
                const active = c.key === category;
                return (
                  <Pressable
                    key={c.key}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setCategory(c.key)}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{c.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.label}>Describe it</Text>
            <TextInput
              style={styles.messageInput}
              placeholder="What did you expect, and what happened instead?"
              placeholderTextColor={colors.textFaint}
              value={message}
              onChangeText={setMessage}
              multiline
              textAlignVertical="top"
            />
            <Text style={[styles.counter, ready && styles.counterOk]}>
              {ready
                ? 'Ready to send'
                : `${Math.max(0, MIN_MESSAGE - message.trim().length)} more characters`}
            </Text>

            <Text style={styles.label}>Where should we reply?</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={colors.textFaint}
              value={contact}
              onChangeText={setContact}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />

            <View style={styles.attachBox}>
              <Icon name="phone-portrait-outline" size={15} color={colors.textMuted} />
              <Text style={styles.attachText}>Attached automatically: {deviceLabel()}</Text>
            </View>

            <Button
              title={sending ? 'Opening mail app...' : 'Send report'}
              onPress={send}
              disabled={!ready}
              loading={sending}
            />

            <Pressable style={styles.secondaryBtn} onPress={copyReport}>
              <Icon name={copied ? 'checkmark-circle' : 'copy-outline'} size={16} color={colors.accent} />
              <Text style={styles.secondaryText}>{copied ? 'Report copied' : 'Copy report instead'}</Text>
            </Pressable>

            <Pressable style={styles.mailRow} onPress={copyEmail}>
              <Icon name="mail-outline" size={16} color={colors.textMuted} />
              <Text style={styles.mailText}>{SUPPORT_EMAIL}</Text>
              <Text style={styles.mailAction}>Copy</Text>
            </Pressable>

            <Text style={styles.fineprint}>
              Reports about abuse or content that breaks the community rules are reviewed first. Include the
              username and a link if you have one.
            </Text>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '92%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  lead: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 16,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  chip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 12.5,
    fontWeight: '600',
  },
  chipTextActive: {
    color: colors.accent,
  },
  messageInput: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 14,
    minHeight: 120,
  },
  counter: {
    color: colors.textFaint,
    fontSize: 11.5,
    fontWeight: '600',
    marginTop: 6,
    marginBottom: 14,
  },
  counterOk: {
    color: colors.success,
  },
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 14,
    marginBottom: 12,
  },
  attachBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 18,
  },
  attachText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginTop: 12,
    paddingVertical: 10,
  },
  secondaryText: {
    color: colors.accent,
    fontSize: 13.5,
    fontWeight: '700',
  },
  mailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 6,
    ...shadows.sm,
  },
  mailText: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  mailAction: {
    color: colors.accent,
    fontSize: 12.5,
    fontWeight: '700',
  },
  fineprint: {
    color: colors.textFaint,
    fontSize: 11.5,
    lineHeight: 17,
    marginTop: 14,
  },
});
