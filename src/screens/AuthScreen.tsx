import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import Button from '../components/Button';

type Mode = 'login' | 'signup';

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const submit = async () => {
    if (!email.trim() || password.length < 6) {
      setError('Enter a valid email and a password of at least 6 characters.');
      return;
    }
    setLoading(true);
    setError(null);
    if (mode === 'signup') {
      const { error: err } = await supabase.auth.signUp({ email: email.trim(), password });
      if (err) {
        setError(err.message);
      } else {
        setCreated(true);
      }
    } else {
      const { error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (err) setError(err.message);
    }
    setLoading(false);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Animated.View
        style={[styles.inner, { opacity: fade, transform: [{ translateY: slide }] }]}
      >
        <View style={styles.logoMark}>
          <Image source={require('../../assets/icon.png')} style={styles.logoImage} />
        </View>
        <Text style={styles.tagline}>Every story. Gone in 48 hours.</Text>

        {created ? (
          <View style={styles.createdBox}>
            <Text style={styles.createdTitle}>Almost there</Text>
            <Text style={styles.createdText}>
              If email confirmation is on, check your inbox. Otherwise we're taking you to set
              up your profile...
            </Text>
          </View>
        ) : (
          <View style={styles.formCard}>
            <View style={styles.segment}>
              {(['login', 'signup'] as Mode[]).map((m) => (
                <Pressable
                  key={m}
                  style={[styles.segmentBtn, mode === m && styles.segmentBtnActive]}
                  onPress={() => {
                    setMode(m);
                    setError(null);
                  }}
                >
                  <Text style={[styles.segmentText, mode === m && styles.segmentTextActive]}>
                    {m === 'login' ? 'Log in' : 'Sign up'}
                  </Text>
                </Pressable>
              ))}
            </View>

            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
            />
            <View style={styles.passwordRow}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Password"
                placeholderTextColor={colors.textFaint}
                secureTextEntry={!showPassword}
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={submit}
              />
              <Pressable
                style={styles.eyeBtn}
                onPress={() => setShowPassword((s) => !s)}
                hitSlop={10}
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
              >
                <Text style={[styles.eyeIcon, showPassword && styles.eyeIconActive]}>👁</Text>
              </Pressable>
            </View>

            {!!error && <Text style={styles.error}>{error}</Text>}

            <Button
              title={mode === 'login' ? 'Log in' : 'Create account'}
              onPress={submit}
              disabled={!email.trim() || !password}
              loading={loading}
              style={{ marginTop: 6 }}
            />
          </View>
        )}
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  formCard: {
    backgroundColor: colors.glass,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 22,
  },
  logoMark: {
    alignSelf: 'center',
    width: 108,
    height: 108,
    borderRadius: 28,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.glow,
  },
  logoImage: {
    width: 92,
    height: 92,
    borderRadius: 20,
  },
  logoText: {
    color: colors.accent,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 2,
  },
  tagline: {
    color: colors.textMuted,
    textAlign: 'center',
    fontSize: 14,
    letterSpacing: 0.4,
    marginTop: 14,
    marginBottom: 24,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 999,
    padding: 4,
    marginBottom: 22,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 999,
    alignItems: 'center',
  },
  segmentBtnActive: {
    backgroundColor: colors.accent,
  },
  segmentText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: colors.bg,
  },
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    marginBottom: 12,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 15,
  },
  eyeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  eyeIcon: {
    fontSize: 18,
    color: colors.textFaint,
  },
  eyeIconActive: {
    color: colors.accent,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    marginBottom: 10,
  },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
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
  createdBox: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 20,
  },
  createdTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
  },
  createdText: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
});
