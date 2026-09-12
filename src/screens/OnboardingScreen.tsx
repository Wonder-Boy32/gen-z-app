import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import Button from '../components/Button';
import { uploadMedia } from '../utils/upload';

const SUGGESTION_WORDS = [
  'nova', 'ace', 'zara', 'bolt', 'moon', 'vibe', 'wolf', 'glitch', 'orbit', 'pixel',
  'king', 'queen', 'crown', 'echo', 'frost', 'haze', 'jolt', 'kilo', 'luna', 'mako',
];

type Step = 0 | 1 | 2 | 3;

function randomSuggestion(): string {
  const w = SUGGESTION_WORDS[Math.floor(Math.random() * SUGGESTION_WORDS.length)];
  const n = Math.floor(Math.random() * 900 + 100);
  return `${w}${n}`;
}

export default function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>(0);
  const [fade] = useState(() => new Animated.Value(0));
  const [slide] = useState(() => new Animated.Value(24));
  const [bounce] = useState(() => new Animated.Value(0.92));
  const [username, setUsername] = useState('');
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [avatar, setAvatar] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // stable per step so suggestions don't shuffle while typing
  const suggestions = useMemo(
    () => [randomSuggestion(), randomSuggestion(), randomSuggestion()],
    [step]
  );

  const animateIn = () => {
    fade.setValue(0);
    slide.setValue(24);
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 420, useNativeDriver: true }),
    ]).start();
  };

  useEffect(() => {
    animateIn();
  }, [step]);

  const pressBounce = () => {
    bounce.setValue(0.92);
    Animated.spring(bounce, {
      toValue: 1,
      friction: 4,
      tension: 140,
      useNativeDriver: true,
    }).start();
  };

  const next = () => setStep((s) => Math.min(s + 1, 3) as Step);

  const checkUsername = async () => {
    const name = username.trim().toLowerCase();
    if (name.length < 3) {
      setAvailable(false);
      return;
    }
    setChecking(true);
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .ilike('username', name)
      .maybeSingle();
    setChecking(false);
    setAvailable(!data);
    if (data) setError('That username is taken.');
    else setError(null);
  };

  const saveUsername = async () => {
    if (!available) return;
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { error: err } = await supabase
      .from('profiles')
      .update({ username: username.trim().toLowerCase() })
      .eq('id', user.id);
    setSaving(false);
    if (err) {
      setError(err.message);
      return;
    }
    next();
  };

  const pickAvatar = async (fromCamera: boolean) => {
    if (fromCamera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setError('Allow camera access to take a photo.');
        return;
      }
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        cameraType: ImagePicker.CameraType.front,
        quality: 0.8,
      });
      if (!res.canceled) setAvatar(res.assets[0]);
    } else {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError('Allow photo access to pick a picture.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
      });
      if (!res.canceled) setAvatar(res.assets[0]);
    }
  };

  const saveAvatar = async () => {
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    try {
      if (avatar) {
        const path = `avatars/${user.id}/avatar-${Date.now()}.jpg`;
        const publicUrl = await uploadMedia(path, avatar.uri, 'image/jpeg');
        await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', user.id);
      }
      next();
    } catch (e: any) {
      setError(e?.message ?? 'Could not save avatar.');
    } finally {
      setSaving(false);
    }
  };

  const stepTitle = ['Welcome to Gen Z', 'Pick your username', 'Set your profile pic', 'You are in'];
  const stepHint = [
    'One feed. Every story. Gone in 48 hours.',
    'This is how the world will know you.',
    'Make it you — or skip it, your call.',
    'Welcome to the family.',
  ];

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* progress dots */}
      <View style={styles.dots}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[styles.dot, i <= step && styles.dotActive]} />
        ))}
      </View>

      <Animated.View
        style={[styles.card, { opacity: fade, transform: [{ translateY: slide }] }]}
      >
        {step === 0 && (
          <View style={styles.center}>
            <Animated.View style={{ transform: [{ scale: bounce }] }}>
              <View style={styles.logoMark}>
                <Image source={require('../../assets/icon-navy.png')} style={styles.logoImage} />
              </View>
            </Animated.View>
            <Text style={styles.title}>{stepTitle[0]}</Text>
            <Text style={styles.hint}>{stepHint[0]}</Text>
            <Button
              title="Get started"
              onPress={() => {
                pressBounce();
                next();
              }}
            />
          </View>
        )}

        {step === 1 && (
          <View style={styles.center}>
            <Text style={styles.title}>{stepTitle[1]}</Text>
            <Text style={styles.hint}>{stepHint[1]}</Text>
            <TextInput
              style={styles.input}
              placeholder="username"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              value={username}
              onChangeText={(t) => {
                setUsername(t);
                setAvailable(null);
                setError(null);
              }}
            />
            {available !== null && !checking && (
              <Text style={[styles.status, available ? styles.statusOk : styles.statusBad]}>
                {available ? 'Available' : 'Taken — try another'}
              </Text>
            )}
            <View style={styles.suggestionRow}>
              {[1, 2, 3].map((i) => {
                const s = suggestions[i - 1];
                return (
                  <Pressable
                    key={`${step}-${i}`}
                    style={styles.suggestionChip}
                    onPress={() => {
                      setUsername(s);
                      setAvailable(null);
                      setError(null);
                    }}
                  >
                    <Text style={styles.suggestionText}>{s}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Button
              title="Continue"
              onPress={() => {
                pressBounce();
                saveUsername();
              }}
              disabled={!username.trim() || !available || checking}
              loading={saving}
            />
            <Pressable style={styles.checkLink} onPress={checkUsername} disabled={checking}>
              <Text style={styles.checkLinkText}>
                {checking ? 'Checking...' : 'Check availability'}
              </Text>
            </Pressable>
          </View>
        )}

        {step === 2 && (
          <View style={styles.center}>
            <Text style={styles.title}>{stepTitle[2]}</Text>
            <Text style={styles.hint}>{stepHint[2]}</Text>
            <Pressable onPress={() => pickAvatar(false)}>
              <View style={styles.avatarRing}>
                {avatar ? (
                  <Image source={{ uri: avatar.uri }} style={styles.avatarImage} />
                ) : (
                  <View style={styles.avatarPlaceholder}>
                    <Text style={styles.avatarLetter}>
                      {username.charAt(0).toUpperCase() || 'G'}
                    </Text>
                  </View>
                )}
                <View style={styles.avatarBadge}>
                  <Text style={styles.avatarBadgeText}>+</Text>
                </View>
              </View>
            </Pressable>
            <Button
              variant="secondary"
              title="Take a photo"
              onPress={() => pickAvatar(true)}
              style={{ marginBottom: 10 }}
            />
            <Button
              variant="secondary"
              title="Choose from gallery"
              onPress={() => pickAvatar(false)}
              style={{ marginBottom: 14 }}
            />
            <Button
              title="Continue"
              onPress={() => {
                pressBounce();
                saveAvatar();
              }}
              loading={saving}
            />
            <Pressable style={styles.skipLink} onPress={saveAvatar}>
              <Text style={styles.skipLinkText}>Skip for now</Text>
            </Pressable>
          </View>
        )}

        {step === 3 && (
          <View style={styles.center}>
            <Animated.View
              style={{
                transform: [
                  {
                    scale: bounce,
                  },
                ],
              }}
            >
              <View style={styles.celebration}>
                <Text style={styles.celebrationMark}>✓</Text>
              </View>
            </Animated.View>
            <Text style={styles.title}>{stepTitle[3]}</Text>
            <Text style={styles.hint}>{stepHint[3]}</Text>
            <Button
              title="Start exploring"
              onPress={() => {
                pressBounce();
                onDone();
              }}
            />
          </View>
        )}

        {!!error && <Text style={styles.error}>{error}</Text>}
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: 28,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 24,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
    marginHorizontal: 4,
  },
  dotActive: {
    backgroundColor: colors.accent,
    width: 22,
  },
  card: {
    alignItems: 'center',
  },
  center: {
    alignItems: 'center',
    width: '100%',
  },
  logoMark: {
    width: 116,
    height: 116,
    borderRadius: 28,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
    ...shadows.glow,
  },
  logoImage: {
    width: 100,
    height: 100,
    borderRadius: 22,
  },
  logoText: {
    color: colors.accent,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 2,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '700',
    textAlign: 'center',
  },
  hint: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 30,
  },
  input: {
    width: '100%',
    backgroundColor: colors.surfaceInput,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 16,
  },
  status: {
    marginTop: 8,
    fontSize: 13,
  },
  statusOk: {
    color: colors.success,
  },
  statusBad: {
    color: colors.danger,
  },
  suggestionRow: {
    flexDirection: 'row',
    marginTop: 12,
    marginBottom: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  suggestionChip: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    margin: 4,
  },
  suggestionText: {
    color: colors.accent,
    fontSize: 13,
  },
  primaryBtn: {
    width: '100%',
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryBtnText: {
    color: colors.bg,
    fontSize: 16,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.85,
  },
  checkLink: {
    marginTop: 14,
  },
  checkLinkText: {
    color: colors.cyan,
    fontSize: 13,
  },
  avatarRing: {
    width: 132,
    height: 132,
    borderRadius: 66,
    borderWidth: 3,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
    ...shadows.glowViolet,
  },
  avatarImage: {
    width: 122,
    height: 122,
    borderRadius: 61,
  },
  avatarPlaceholder: {
    width: 122,
    height: 122,
    borderRadius: 61,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.accent,
    fontSize: 46,
    fontWeight: '800',
  },
  avatarBadge: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarBadgeText: {
    color: colors.bg,
    fontSize: 18,
    fontWeight: '700',
  },
  secondaryBtn: {
    width: '100%',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 13,
    alignItems: 'center',
    marginBottom: 10,
  },
  secondaryBtnText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  skipLink: {
    marginTop: 12,
  },
  skipLinkText: {
    color: colors.textFaint,
    fontSize: 13,
  },
  celebration: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
    ...shadows.glow,
  },
  celebrationMark: {
    color: colors.bg,
    fontSize: 52,
    fontWeight: '800',
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    marginTop: 14,
    textAlign: 'center',
  },
});
