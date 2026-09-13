import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../../supabase/client';
import { colors, radius, shadows } from '../../theme';
import Icon, { IconName } from '../ui/Icon';
import { CHAT_COLORS, WALLPAPERS, resolveChatPalette, customWallpaperUri, isCustomWallpaper } from '../../utils/chatTheme';
import { uploadMedia } from '../../utils/upload';
import { useSheetPad } from '../../utils/useSheetPad';

export type ChatSettingsData = {
  muted: boolean;
  mutedUntil: string | null;
  nickname: string | null;
  chatColor: string;
  wallpaper: string;
  disappearSeconds: number | null;
  soundEnabled: boolean;
};

export type SearchableMessage = {
  id: string;
  content: string | null;
  msg_type: string;
  created_at: string;
  sender_id: string;
  deleted_at: string | null;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  convId: string;
  isGroup: boolean;
  other: { id: string; username: string; avatar_url: string | null } | null;
  settings: ChatSettingsData | null;
  onChange: (patch: Partial<ChatSettingsData>) => void;
  messages: SearchableMessage[];
  onJump: (messageId: string) => void;
  onBlocked: () => void;
};

type Sub = null | 'mute' | 'disappear' | 'theme' | 'nickname' | 'search' | 'safety';

const DISAPPEAR_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: 'Off', seconds: null },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
  { label: '90 days', seconds: 2592000 },
];

function isMuted(s: ChatSettingsData | null): boolean {
  if (!s?.muted) return false;
  if (!s.mutedUntil) return true; // "always"
  return new Date(s.mutedUntil).getTime() > Date.now();
}

function safetyNumber(a: string, b: string): string {
  const seed = [a, b].sort().join(':');
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  let out = '';
  let x = h >>> 0;
  for (let i = 0; i < 60; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += String(x % 10);
  }
  return out.replace(/(\d{5})(?=\d)/g, '$1 ');
}

export default function ChatSettingsSheet({
  visible,
  onClose,
  convId,
  isGroup,
  other,
  settings,
  onChange,
  messages,
  onJump,
  onBlocked,
}: Props) {
  const [sub, setSub] = useState<Sub>(null);
  const [nick, setNick] = useState('');
  const [added, setAdded] = useState(false);
  const [uploadingWall, setUploadingWall] = useState(false);
  const [query, setQuery] = useState('');

  const sheetPad = useSheetPad(30);

  useEffect(() => {
    if (visible) {
      setSub(null);
      setNick(settings?.nickname ?? '');
      setAdded(false);
      setQuery('');
    }
  }, [visible, settings?.nickname]);

  if (!visible) return null;

  const muted = isMuted(settings);

  const saveParticipant = async (patch: Record<string, any>, localPatch: Partial<ChatSettingsData>) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      await supabase
        .from('conversation_participants')
        .update(patch)
        .eq('conversation_id', convId)
        .eq('user_id', user.id);
      onChange(localPatch);
    } catch (e: any) {
      console.warn('settings save error', e?.message);
    }
  };

  const close = () => {
    setSub(null);
    onClose();
  };

  const pickWallpaperPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (res.canceled || !res.assets[0]) return;
    setUploadingWall(true);
    try {
      const path = `chat/${convId}/wall-${Date.now()}.jpg`;
      const publicUrl = await uploadMedia(path, res.assets[0].uri, res.assets[0].mimeType ?? 'image/jpeg');
      await saveParticipant({ wallpaper: `custom:${publicUrl}` }, { wallpaper: `custom:${publicUrl}` });
      setSub(null);
    } catch (e: any) {
      console.warn('wallpaper upload error', e?.message);
      Alert.alert('Upload failed', 'Could not upload that photo. Try a different one.');
    } finally {
      setUploadingWall(false);
    }
  };

  const addContact = async () => {
    if (!other || added) return;
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data: existing } = await supabase
        .from('follows')
        .select('id')
        .eq('follower_id', user.id)
        .eq('following_id', other.id)
        .maybeSingle();
      if (existing) {
        setAdded(true);
        return;
      }
      const { error } = await supabase.from('follows').insert({ follower_id: user.id, following_id: other.id });
      if (!error) setAdded(true);
    } catch {}
  };

  const confirmBlock = () => {
    if (!other) return;
    Alert.alert('Block @' + other.username, 'You will no longer receive messages from this user and the chat will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block',
        style: 'destructive',
        onPress: async () => {
          try {
            await supabase.rpc('block_chat_user', { p_other: other.id });
            onBlocked();
          } catch (e: any) {
            console.warn('block error', e?.message);
          }
        },
      },
    ]);
  };

  const confirmReport = () => {
    if (!other) return;
    Alert.alert('Report @' + other.username, 'Report this chat for spam or abuse? Our team will review it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Report',
        style: 'destructive',
        onPress: async () => {
          try {
            const {
              data: { user },
            } = await supabase.auth.getUser();
            if (!user) return;
            await supabase.from('chat_reports').insert({
              reporter_id: user.id,
              conversation_id: convId,
              reported_user_id: other.id,
            });
            close();
            Alert.alert('Reported', 'Thanks — we\'ll review it.');
          } catch (e: any) {
            console.warn('report error', e?.message);
          }
        },
      },
    ]);
  };

  const results = query.trim()
    ? messages
        .filter(
          (m) =>
            !m.deleted_at &&
            ((m.content ?? '').toLowerCase().includes(query.trim().toLowerCase()) ||
              (m.msg_type === 'image' && 'photo'.includes(query.trim().toLowerCase())) ||
              (m.msg_type === 'video' && 'video'.includes(query.trim().toLowerCase())))
        )
        .slice(0, 30)
    : [];

  const name = isGroup ? 'Group' : other ? `@${other.username}` : '';
  const palette = resolveChatPalette(settings?.chatColor);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <Pressable style={styles.overlay} onPress={close}>
        <Pressable style={[styles.sheet, { paddingBottom: sheetPad }]} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grabber} />
          {sub === null && (
            <>
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>Chat settings</Text>
                <Pressable onPress={close} hitSlop={8}>
                  <Icon name="close" size={22} color={colors.textMuted} />
                </Pressable>
              </View>
              <ScrollView bounces={false}>
                {/* quick actions — Signal style */}
                <View style={styles.quickRow}>
                  <Pressable style={styles.quickTile} onPress={() => setSub('mute')}>
                    <Icon name={muted ? 'notifications-off' : 'notifications-outline'} size={24} color={muted ? colors.accent : colors.text} />
                    <Text style={styles.quickLabel}>{muted ? 'Muted' : 'Mute'}</Text>
                  </Pressable>
                  <Pressable style={styles.quickTile} onPress={() => setSub('search')}>
                    <Icon name="search" size={24} color={colors.text} />
                    <Text style={styles.quickLabel}>Search</Text>
                  </Pressable>
                </View>

                <View style={styles.divider} />

                <Row icon="timer-outline" label="Disappearing messages" value={DISAPPEAR_OPTIONS.find((o) => o.seconds === settings?.disappearSeconds)?.label ?? 'Off'} onPress={() => setSub('disappear')} />
                {!isGroup && <Row icon="create-outline" label="Nickname" value={settings?.nickname ?? undefined} onPress={() => setSub('nickname')} />}
                <Row icon="color-palette-outline" label="Chat color & wallpaper" value={palette.label} onPress={() => setSub('theme')} />
                <Row
                  icon="volume-high-outline"
                  label="Sounds & notifications"
                  right={
                    <Switch
                      value={settings?.soundEnabled ?? true}
                      onValueChange={(v) => saveParticipant({ sound_enabled: v }, { soundEnabled: v })}
                      trackColor={{ false: colors.border, true: colors.accent }}
                      thumbColor={colors.logoWhite}
                    />
                  }
                  onPress={() => {}}
                />
                {!isGroup && other && (
                  <Row
                    icon="person-add-outline"
                    label="Add as a contact"
                    value={added ? 'Added' : undefined}
                    onPress={addContact}
                  />
                )}
                {!isGroup && other && (
                  <Row icon="shield-checkmark-outline" label="View safety number" onPress={() => setSub('safety')} />
                )}

                {!isGroup && other && (
                  <>
                    <View style={styles.divider} />
                    <Row icon="ban-outline" label={`Block @${other.username}`} danger onPress={confirmBlock} />
                    <Row icon="alert-circle-outline" label="Report spam" danger onPress={confirmReport} />
                  </>
                )}
              </ScrollView>
            </>
          )}

          {sub === 'mute' && (
            <SubSheet title="Mute notifications" onBack={() => setSub(null)}>
              {[
                { label: muted ? 'Unmute' : 'Mute', value: null as string | null },
                { label: '8 hours', value: new Date(Date.now() + 8 * 3600000).toISOString() },
                { label: '1 week', value: new Date(Date.now() + 7 * 86400000).toISOString() },
                { label: 'Always', value: null },
              ].map((o) => (
                <ChoiceRow
                  key={o.label}
                  label={o.label}
                  active={muted && o.value === settings?.mutedUntil}
                  onPress={() => {
                    if (!muted) {
                      // pressing "Mute" (or a duration) = mute
                      saveParticipant({ muted: true, muted_until: o.value }, { muted: true, mutedUntil: o.value });
                    } else if (o.label === 'Unmute') {
                      saveParticipant({ muted: false, muted_until: null }, { muted: false, mutedUntil: null });
                    } else {
                      // already muted → switch duration
                      saveParticipant({ muted: true, muted_until: o.value }, { muted: true, mutedUntil: o.value });
                    }
                    setSub(null);
                  }}
                />
              ))}
            </SubSheet>
          )}

          {sub === 'disappear' && (
            <SubSheet title="Disappearing messages" onBack={() => setSub(null)}>
              <Text style={styles.subHint}>
                Messages older than this timer are deleted for everyone in the chat.
              </Text>
              {DISAPPEAR_OPTIONS.map((o) => (
                <ChoiceRow
                  key={o.label}
                  label={o.label}
                  active={settings?.disappearSeconds === o.seconds}
                  onPress={async () => {
                    try {
                      await supabase.from('conversations').update({ disappear_seconds: o.seconds }).eq('id', convId);
                      onChange({ disappearSeconds: o.seconds });
                    } catch (e: any) {
                      console.warn('disappear save error', e?.message);
                    }
                    setSub(null);
                  }}
                />
              ))}
            </SubSheet>
          )}

          {sub === 'theme' && (
            <SubSheet title="Chat color & wallpaper" onBack={() => setSub(null)}>
              <Text style={styles.subHint}>Bubble color</Text>
              <View style={styles.swatchRow}>
                {CHAT_COLORS.map((c) => (
                  <Pressable
                    key={c.key}
                    style={[styles.swatch, { backgroundColor: c.myBg }, settings?.chatColor === c.key && styles.swatchActive]}
                    onPress={() => saveParticipant({ chat_color: c.key }, { chatColor: c.key })}
                  >
                    {settings?.chatColor === c.key && <Icon name="checkmark" size={16} color={c.myText} />}
                  </Pressable>
                ))}
              </View>
              <Text style={styles.subHint}>Wallpaper</Text>
              <View style={styles.wallRow}>
                {WALLPAPERS.map((w) => (
                  <Pressable
                    key={w.key}
                    style={styles.wallTile}
                    onPress={() => saveParticipant({ wallpaper: w.key }, { wallpaper: w.key })}
                  >
                    <View
                      style={[
                        styles.wallPreview,
                        { backgroundColor: w.base === 'transparent' ? colors.surfaceAlt : w.base },
                        settings?.wallpaper === w.key && styles.wallPreviewActive,
                      ]}
                    >
                      {w.glows.map((g, i) => (
                        <View
                          key={i}
                          style={{
                            position: 'absolute',
                            width: 60,
                            height: 60,
                            borderRadius: 30,
                            top: g.top,
                            left: g.left,
                            right: g.right,
                            backgroundColor: g.color,
                          }}
                        />
                      ))}
                    </View>
                    <Text style={styles.wallLabel}>{w.label}</Text>
                  </Pressable>
                ))}
                <Pressable style={styles.wallTile} onPress={pickWallpaperPhoto} disabled={uploadingWall}>
                  <View style={[styles.wallPreview, styles.wallCustom]}>
                    {uploadingWall ? (
                      <ActivityIndicator color={colors.accent} size="small" />
                    ) : (
                      <Icon name="image-outline" size={20} color={colors.accent} />
                    )}
                  </View>
                  <Text style={styles.wallLabel}>Photo</Text>
                </Pressable>
              </View>
              {isCustomWallpaper(settings?.wallpaper ?? '') && (
                <Pressable style={styles.resetWall} onPress={() => saveParticipant({ wallpaper: 'glow' }, { wallpaper: 'glow' })}>
                  <Text style={styles.resetWallText}>Reset wallpaper</Text>
                </Pressable>
              )}
              {isCustomWallpaper(settings?.wallpaper ?? '') && (
                <>
                  <Text style={styles.customPreviewLabel}>Current photo:</Text>
                  <Image
                    source={{ uri: customWallpaperUri(settings!.wallpaper) }}
                    style={styles.customPreview}
                    resizeMode="cover"
                  />
                </>
              )}
            </SubSheet>
          )}

          {sub === 'nickname' && (
            <SubSheet title={`Nickname for ${other ? `@${other.username}` : 'this chat'}`} onBack={() => setSub(null)}>
              <Text style={styles.subHint}>Only you can see this. It replaces the username in the header.</Text>
              <TextInput
                style={styles.input}
                value={nick}
                onChangeText={setNick}
                placeholder="Nickname…"
                placeholderTextColor={colors.textFaint}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => saveParticipant({ nickname: nick.trim() || null }, { nickname: nick.trim() || null })}
              />
              <Pressable
                style={[styles.primaryBtn, !nick.trim() && styles.btnDisabled]}
                onPress={() => {
                  saveParticipant({ nickname: nick.trim() || null }, { nickname: nick.trim() || null });
                  setSub(null);
                }}
              >
                <Text style={styles.primaryBtnText}>Save</Text>
              </Pressable>
              {!!settings?.nickname && (
                <Pressable
                  style={styles.clearBtn}
                  onPress={() => {
                    saveParticipant({ nickname: null }, { nickname: null });
                    setSub(null);
                  }}
                >
                  <Text style={styles.clearBtnText}>Remove nickname</Text>
                </Pressable>
              )}
            </SubSheet>
          )}

          {sub === 'search' && (
            <SubSheet title="Search in chat" onBack={() => setSub(null)} tall>
              <TextInput
                style={styles.input}
                value={query}
                onChangeText={setQuery}
                placeholder="Search messages…"
                placeholderTextColor={colors.textFaint}
                autoFocus
                returnKeyType="search"
              />
              <ScrollView style={styles.searchResults} keyboardShouldPersistTaps="handled">
                {query.trim() && results.length === 0 && (
                  <Text style={styles.searchEmpty}>No messages match “{query.trim()}”.</Text>
                )}
                {results.map((m) => (
                  <Pressable
                    key={m.id}
                    style={styles.searchRow}
                    onPress={() => {
                      onJump(m.id);
                      setSub(null);
                      onClose();
                    }}
                  >
                    <Text style={styles.searchText} numberOfLines={2}>
                      {m.content ?? (m.msg_type === 'image' ? '📷 Photo' : m.msg_type === 'video' ? '🎬 Video' : m.msg_type)}
                    </Text>
                    <Text style={styles.searchTime}>
                      {new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </SubSheet>
          )}

          {sub === 'safety' && other && (
            <SubSheet title="Safety number" onBack={() => setSub(null)}>
              <Text style={styles.subHint}>
                Compare this number with {name} to verify this chat is end-to-end secure.
              </Text>
              <View style={styles.safetyCard}>
                <Text style={styles.safetyText}>{safetyNumber(convId, other.id)}</Text>
              </View>
              <Pressable style={styles.primaryBtn} onPress={() => setSub(null)}>
                <Text style={styles.primaryBtnText}>Done</Text>
              </Pressable>
            </SubSheet>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({
  icon,
  label,
  value,
  right,
  danger,
  onPress,
}: {
  icon: IconName;
  label: string;
  value?: string;
  right?: React.ReactNode;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Icon name={icon} size={19} color={danger ? colors.danger : colors.textMuted} />
      <Text style={[styles.rowLabel, danger && styles.rowLabelDanger]} numberOfLines={1}>
        {label}
      </Text>
      {value !== undefined && <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>}
      {right ?? <Icon name="chevron-forward" size={16} color={colors.textFaint} />}
    </Pressable>
  );
}

function SubSheet({
  title,
  onBack,
  children,
  tall,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
  tall?: boolean;
}) {
  return (
    <View style={[styles.subBody, tall && styles.subBodyTall]}>
      <View style={styles.subHeader}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Icon name="arrow-back" size={20} color={colors.accent} />
        </Pressable>
        <Text style={styles.subTitle}>{title}</Text>
        <View style={{ width: 20 }} />
      </View>
      {children}
    </View>
  );
}

function ChoiceRow({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.choiceRow} onPress={onPress}>
      <Text style={styles.choiceLabel}>{label}</Text>
      {active && <Icon name="checkmark" size={18} color={colors.accent} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(2,4,10,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '82%',
    paddingBottom: 30,
    ...shadows.md,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginTop: 8,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  quickRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 18,
    paddingBottom: 6,
  },
  quickTile: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    gap: 6,
  },
  quickLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 8,
    marginHorizontal: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  rowLabel: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  rowLabelDanger: {
    color: colors.danger,
  },
  rowValue: {
    color: colors.textMuted,
    fontSize: 13,
    maxWidth: '45%',
  },
  subBody: {
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  subBodyTall: {
    minHeight: 340,
  },
  subHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 10,
    marginBottom: 4,
  },
  subTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  subHint: {
    color: colors.textMuted,
    fontSize: 13,
    marginBottom: 12,
  },
  choiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  choiceLabel: {
    color: colors.text,
    fontSize: 15,
  },
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 14,
  },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    alignItems: 'center',
    paddingVertical: 13,
    marginTop: 4,
  },
  primaryBtnText: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '800',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  clearBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 6,
  },
  clearBtnText: {
    color: colors.danger,
    fontSize: 14,
    fontWeight: '700',
  },
  swatchRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 18,
  },
  swatch: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchActive: {
    borderWidth: 2.5,
    borderColor: colors.text,
  },
  wallRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  wallTile: {
    alignItems: 'center',
    width: 76,
    marginBottom: 10,
  },
  wallTileActive: {
    opacity: 1,
  },
  wallPreview: {
    width: 64,
    height: 64,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
  wallPreviewActive: {
    borderColor: colors.accent,
    borderWidth: 3,
  },
  wallTileActiveBorder: {
    borderColor: colors.accent,
  },
  wallCustom: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderStyle: 'dashed',
  },
  wallLabel: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 5,
  },
  resetWall: {
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  resetWallText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  customPreviewLabel: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 10,
  },
  customPreview: {
    width: '100%',
    height: 140,
    borderRadius: radius.md,
    marginTop: 8,
  },
  searchResults: {
    marginTop: 4,
    maxHeight: 300,
  },
  searchRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  searchText: {
    color: colors.text,
    fontSize: 14,
  },
  searchTime: {
    color: colors.textFaint,
    fontSize: 11,
    marginTop: 3,
  },
  searchEmpty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 24,
  },
  safetyCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: 18,
    marginBottom: 14,
  },
  safetyText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1.5,
    lineHeight: 26,
    fontVariant: ['tabular-nums'],
  },
});
