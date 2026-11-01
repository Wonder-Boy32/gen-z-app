import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius } from '../theme';

const WHO_OPTS: { key: string; label: string }[] = [
  { key: 'everyone', label: 'Everyone' },
  { key: 'followers', label: 'Followers' },
  { key: 'link', label: 'People with my link' },
  { key: 'nobody', label: 'Nobody' },
];

const TYPE_OPTS: { key: 'allow_text' | 'allow_photos' | 'allow_voice' | 'allow_drops'; label: string }[] = [
  { key: 'allow_text', label: 'Text' },
  { key: 'allow_photos', label: 'Photos' },
  { key: 'allow_voice', label: 'Voice' },
  { key: 'allow_drops', label: 'Anonymous Drops' },
];

export default function AnonymousSettingsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(true);
  const [who, setWho] = useState('everyone');
  const [types, setTypes] = useState({ allow_text: true, allow_photos: true, allow_voice: true, allow_drops: false });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from('anonymous_settings').select('*').eq('user_id', user.id).maybeSingle();
      if (data) {
        setEnabled((data as any).enabled);
        setWho((data as any).who);
        setTypes({
          allow_text: (data as any).allow_text,
          allow_photos: (data as any).allow_photos,
          allow_voice: (data as any).allow_voice,
          allow_drops: (data as any).allow_drops,
        });
      }
    })();
  }, [visible]);

  const save = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setSaving(true);
    await supabase.from('anonymous_settings').upsert({
      user_id: user.id,
      enabled,
      who,
      ...types,
      updated_at: new Date().toISOString(),
    });
    setSaving(false);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>🕵️ Anonymous Messages</Text>

          <Pressable style={styles.switchRow} onPress={() => setEnabled((v) => !v)}>
            <Text style={styles.rowLabel}>Allow anonymous messages</Text>
            <View style={[styles.switch, enabled && styles.switchOn]}>
              <View style={[styles.switchKnob, enabled && styles.switchKnobOn]} />
            </View>
          </Pressable>

          <Text style={styles.sectionLabel}>Who can send</Text>
          <View style={styles.whoRow}>
            {WHO_OPTS.map((o) => (
              <Pressable
                key={o.key}
                style={[styles.whoChip, who === o.key && styles.whoChipActive]}
                onPress={() => setWho(o.key)}
              >
                <Text style={[styles.whoChipText, who === o.key && styles.whoChipTextActive]}>{o.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Content</Text>
          <View style={styles.typeRow}>
            {TYPE_OPTS.map((o) => (
              <Pressable
                key={o.key}
                style={[styles.typeChip, types[o.key] && styles.typeChipActive]}
                onPress={() => setTypes((t) => ({ ...t, [o.key]: !t[o.key] }))}
              >
                <Text style={[styles.typeChipText, types[o.key] && styles.typeChipTextActive]}>
                  {types[o.key] ? `☑ ${o.label}` : `☐ ${o.label}`}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.hint}>Recipients see "Anonymous" — never the sender's identity. Abuse can be reported.</Text>

          <Pressable style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving}>
            {saving ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.saveText}>Save</Text>}
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#0d1426',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 40,
    borderWidth: 1,
    borderColor: colors.chromeBorder,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '900', marginBottom: 16 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  rowLabel: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
  switch: { width: 46, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.15)', padding: 3 },
  switchOn: { backgroundColor: colors.accent },
  switchKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  switchKnobOn: { marginLeft: 20 },
  sectionLabel: { color: colors.textMuted, fontSize: 11.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  whoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  whoChip: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  whoChipActive: { borderColor: colors.accent, backgroundColor: 'rgba(229,43,255,0.16)' },
  whoChipText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  whoChipTextActive: { color: colors.accent },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  typeChip: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  typeChipActive: { borderColor: colors.accent, backgroundColor: 'rgba(229,43,255,0.14)' },
  typeChipText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  typeChipTextActive: { color: colors.accent },
  hint: { color: colors.textMuted, fontSize: 11.5, lineHeight: 16, marginBottom: 18 },
  saveBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveText: { color: colors.bg, fontSize: 15, fontWeight: '800' },
});
