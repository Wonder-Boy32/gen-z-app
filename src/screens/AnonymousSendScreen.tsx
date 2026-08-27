import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import Icon from '../components/ui/Icon';
import { TOP_INSET } from '../utils/useInsets';
import { uploadMedia } from '../utils/upload';

const MAX_LEN = 500;
const TEMP_OPTIONS: { key: 'none' | '24h' | '48h'; label: string }[] = [
  { key: 'none', label: 'Stays' },
  { key: '24h', label: '⏳ 24h' },
  { key: '48h', label: '⏳ 48h' },
];

const ERR_TEXT: Record<string, string> = {
  anon_disabled: "They've turned off anonymous messages.",
  anon_who_nobody: "They're not accepting anonymous messages right now.",
  anon_who_followers: 'They only accept anonymous messages from followers.',
  anon_who_link: "They only accept anonymous messages from people with their link.",
  anon_blocked: "You can't send anonymous messages to this person.",
  anon_rate_sender: 'Too many messages — take a breather and try again later.',
  anon_rate_recipient: 'That inbox is busy — try again in a little while.',
  anon_no_photos: "They don't accept anonymous photos.",
  anon_no_voice: "They don't accept anonymous voice messages.",
};

export default function AnonymousSendScreen({
  recipientId,
  recipientName,
  onBack,
}: {
  recipientId: string;
  recipientName: string;
  onBack: () => void;
}) {
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [temp, setTemp] = useState<'none' | '24h' | '48h'>('none');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const pickPhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (!res.canceled && res.assets?.[0]) setPhoto(res.assets[0].uri);
  };

  const send = async () => {
    if (sending) return;
    if (!text.trim() && !photo) {
      setError('Write something or add a photo first.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      let mediaUrl: string | null = null;
      if (photo) {
        mediaUrl = await uploadMedia(`anon/${recipientId}/${Date.now()}.jpg`, photo, 'image/jpeg');
      }
      const { error: rpcErr } = await supabase.rpc('send_anonymous_message', {
        p_recipient: recipientId,
        p_content: text.trim() ? text.trim() : null,
        p_media: mediaUrl,
        p_voice: null,
        p_type: mediaUrl ? 'photo' : 'text',
        p_expires: temp === '24h' ? '24 hours' : temp === '48h' ? '48 hours' : null,
      });
      if (rpcErr) {
        const msg = (rpcErr.message ?? '').toLowerCase();
        const key = Object.keys(ERR_TEXT).find((k) => msg.includes(k.toLowerCase()));
        setError(key ? ERR_TEXT[key] : `Couldn't send: ${rpcErr.message}`);
        setSending(false);
        return;
      }
      setSent(true);
    } catch (e: any) {
      setError(`Couldn't send: ${e?.message ?? 'unknown error'}`);
    }
    setSending(false);
  };

  if (sent) {
    return (
      <View style={styles.container}>
        <View style={styles.topBar}>
          <Pressable style={styles.backBtn} onPress={onBack} hitSlop={8}>
            <Icon name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topTitle}>🕵️ Sent</Text>
        </View>
        <View style={styles.sentWrap}>
          <View style={styles.sentIcon}>
            <Icon name="eye-off-outline" size={30} color={colors.accent} />
          </View>
          <Text style={styles.sentTitle}>Sent anonymously 👀</Text>
          <Text style={styles.sentSub}>
            @{recipientName} won't know it was you.
            {temp !== 'none' ? ` It disappears ${temp === '24h' ? 'in 24 hours' : 'in 48 hours'}.` : ''}
          </Text>
          <Pressable style={styles.sendAnother} onPress={() => { setText(''); setPhoto(null); setSent(false); }}>
            <Text style={styles.sendAnotherText}>Send another</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable style={styles.backBtn} onPress={onBack} hitSlop={8}>
          <Icon name="chevron-back" size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>🕵️ SEND ANONYMOUSLY</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.headline}>
          Send <Text style={styles.headlineName}>@{recipientName}</Text> a message.
        </Text>
        <Text style={styles.subline}>They won't see your identity — just the message.</Text>

        <View style={styles.inputCard}>
          <TextInput
            style={styles.input}
            placeholder="Write something..."
            placeholderTextColor={colors.textMuted}
            value={text}
            onChangeText={setText}
            maxLength={MAX_LEN}
            multiline
          />
          {photo && (
            <View style={styles.photoWrap}>
              <Image source={{ uri: photo }} style={styles.photo} />
              <Pressable style={styles.removePhoto} onPress={() => setPhoto(null)} hitSlop={8}>
                <Icon name="close" size={14} color={colors.bg} />
              </Pressable>
            </View>
          )}
          <View style={styles.inputFooter}>
            <Text style={styles.counter}>{text.length}/{MAX_LEN}</Text>
            <Pressable style={styles.attachBtn} onPress={pickPhoto}>
              <Icon name="image-outline" size={18} color={colors.textMuted} />
            </Pressable>
          </View>
        </View>

        <View style={styles.tempRow}>
          <Text style={styles.tempLabel}>⏳ Disappears</Text>
          {TEMP_OPTIONS.map((o) => (
            <Pressable
              key={o.key}
              style={[styles.tempChip, temp === o.key && styles.tempChipActive]}
              onPress={() => setTemp(o.key)}
            >
              <Text style={[styles.tempChipText, temp === o.key && styles.tempChipTextActive]}>{o.label}</Text>
            </Pressable>
          ))}
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={[styles.sendBtn, sending && styles.sendBtnDisabled]} onPress={send} disabled={sending}>
          {sending ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <>
              <Icon name="eye-off" size={16} color={colors.bg} />
              <Text style={styles.sendBtnText}>Send anonymously</Text>
            </>
          )}
        </Pressable>
        <Text style={styles.safetyNote}>
          🛡️ Anonymous doesn't mean untraceable — abusive or harmful messages can be reported and acted on.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingTop: TOP_INSET + 8,
    paddingBottom: 10,
    paddingHorizontal: 14,
  },
  backBtn: { padding: 4 },
  topTitle: { color: colors.text, fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
  body: { padding: 20, paddingBottom: 60 },
  headline: { color: colors.text, fontSize: 22, fontWeight: '900', marginTop: 8 },
  headlineName: { color: colors.accent },
  subline: { color: colors.textMuted, fontSize: 13, marginTop: 6, marginBottom: 20 },
  inputCard: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: radius.lg,
    padding: 14,
    ...shadows.glow,
  },
  input: { color: colors.text, fontSize: 15, minHeight: 110, textAlignVertical: 'top' },
  photoWrap: { marginTop: 10, alignSelf: 'flex-start' },
  photo: { width: 120, height: 160, borderRadius: radius.md },
  removePhoto: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: colors.accent,
    borderRadius: 99,
    padding: 4,
  },
  inputFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
  counter: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  attachBtn: { padding: 6 },
  tempRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18 },
  tempLabel: { color: colors.textMuted, fontSize: 12.5, fontWeight: '700' },
  tempChip: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  tempChipActive: { borderColor: colors.accent, backgroundColor: 'rgba(255,122,0,0.16)' },
  tempChipText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  tempChipTextActive: { color: colors.accent },
  error: { color: '#ff6b6b', fontSize: 12.5, fontWeight: '600', marginTop: 14 },
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: 15,
    marginTop: 22,
  },
  sendBtnDisabled: { opacity: 0.6 },
  sendBtnText: { color: colors.bg, fontSize: 15, fontWeight: '800' },
  safetyNote: { color: colors.textMuted, fontSize: 11, marginTop: 14, lineHeight: 16, textAlign: 'center' },
  sentWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  sentIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,122,0,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  sentTitle: { color: colors.text, fontSize: 19, fontWeight: '900' },
  sentSub: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 19 },
  sendAnother: {
    marginTop: 22,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  sendAnotherText: { color: colors.accent, fontWeight: '800', fontSize: 13 },
});
