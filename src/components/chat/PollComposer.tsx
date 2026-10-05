// ============================================================
// PollComposer — the bottom sheet used to author a poll (§29).
//
// It is deliberately "dumb": it validates the draft, hands it to the
// parent through onCreate(), and closes. Persistence lives in the
// parent (see createPoll() in src/messaging/api.ts), because the
// message row and the polls row have to be written together.
//
// Everything visual comes from src/theme.ts — no colours are invented
// here. Column names used downstream are the exact ones from
// supabase/messaging_v2.sql (polls: question, options, multi,
// anonymous, closes_at).
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radius, spacing, type } from '../../theme';
import { useSheetPad } from '../../utils/useSheetPad';

/** The draft handed to the parent on submit. Mirrors messaging/api.ts PollDraft. */
export interface PollDraft {
  question: string;
  options: string[]; // 2..8 non-empty, trimmed
  multi: boolean; // allow multiple choices
  anonymous: boolean; // hide who voted
  closesAt: string | null; // ISO timestamp or null for no deadline
}

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreate: (poll: PollDraft) => void;
};

type CloseChoice = 'none' | '1h' | '1d' | '1w';

const CLOSE_OPTIONS: { key: CloseChoice; label: string }[] = [
  { key: 'none', label: 'No deadline' },
  { key: '1h', label: '1 hour' },
  { key: '1d', label: '1 day' },
  { key: '1w', label: '1 week' },
];

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;

/** Rows carry a stable key so removing one never steals another's focus. */
interface OptionRow {
  key: string;
  value: string;
}

let optionSeq = 0;

function makeRow(): OptionRow {
  optionSeq += 1;
  return { key: `poll-opt-${optionSeq}`, value: '' };
}

function closeChoiceToIso(choice: CloseChoice): string | null {
  const hour = 3600000;
  switch (choice) {
    case '1h':
      return new Date(Date.now() + hour).toISOString();
    case '1d':
      return new Date(Date.now() + 24 * hour).toISOString();
    case '1w':
      return new Date(Date.now() + 7 * 24 * hour).toISOString();
    case 'none':
    default:
      return null;
  }
}

export default function PollComposer({ visible, onClose, onCreate }: Props) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<OptionRow[]>(() => [makeRow(), makeRow()]);
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [closeChoice, setCloseChoice] = useState<CloseChoice>('none');

  const sheetPad = useSheetPad(spacing.xxl);

  // A fresh form every time the sheet opens, so a half-typed abandoned
  // poll never reappears on the next open.
  useEffect(() => {
    if (!visible) return;
    setQuestion('');
    setOptions([makeRow(), makeRow()]);
    setMulti(false);
    setAnonymous(false);
    setCloseChoice('none');
  }, [visible]);

  const trimmedQuestion = question.trim();
  const filledOptions = useMemo(() => {
    const seen = new Set<string>();
    let duplicates = false;
    const values: string[] = [];
    for (const row of options) {
      const value = row.value.trim();
      if (value.length === 0) continue;
      const lower = value.toLowerCase();
      if (seen.has(lower)) duplicates = true;
      seen.add(lower);
      values.push(value);
    }
    return { values, duplicates };
  }, [options]);

  const hasQuestion = trimmedQuestion.length > 0;
  const enoughOptions = filledOptions.values.length >= MIN_OPTIONS;
  const canCreate = hasQuestion && enoughOptions && !filledOptions.duplicates;

  // One sentence explaining exactly what is still missing.
  const hint = !hasQuestion
    ? 'Add a question to continue.'
    : !enoughOptions
      ? `Add at least ${MIN_OPTIONS} options to continue.`
      : filledOptions.duplicates
        ? 'Options must be unique (case does not matter).'
        : null;

  const filledCount = filledOptions.values.length;
  const canAddOption = options.length < MAX_OPTIONS && filledCount < MAX_OPTIONS;
  const canRemoveOption = options.length > MIN_OPTIONS;

  function updateOption(key: string, value: string) {
    setOptions((prev) => prev.map((row) => (row.key === key ? { ...row, value } : row)));
  }

  function addOption() {
    setOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, makeRow()]));
  }

  function removeOption(key: string) {
    setOptions((prev) => (prev.length <= MIN_OPTIONS ? prev : prev.filter((row) => row.key !== key)));
  }

  function submit() {
    if (!canCreate) return;
    onCreate({
      question: trimmedQuestion,
      options: filledOptions.values.slice(0, MAX_OPTIONS),
      multi,
      anonymous,
      closesAt: closeChoiceToIso(closeChoice),
    });
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.overlay} onPress={onClose} accessibilityLabel="Dismiss poll composer">
        <Pressable
          style={[styles.sheet, { paddingBottom: sheetPad }]}
          onPress={(e) => e.stopPropagation()}
          accessibilityViewIsModal
        >
          <View style={styles.grabber} />

          <View style={styles.header}>
            <Text style={styles.title}>New poll</Text>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close poll composer"
              style={styles.closeBtn}
            >
              <Text style={styles.closeGlyph}>×</Text>
            </Pressable>
          </View>

          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Question</Text>
            <TextInput
              value={question}
              onChangeText={setQuestion}
              placeholder="Ask something…"
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              multiline
              maxLength={200}
              accessibilityLabel="Poll question"
            />

            <View style={styles.labelRow}>
              <Text style={styles.label}>Options</Text>
              <Text style={styles.counter}>
                {filledCount}/{MAX_OPTIONS}
              </Text>
            </View>

            {options.map((row, index) => (
              <View key={row.key} style={styles.optionRow}>
                <TextInput
                  value={row.value}
                  onChangeText={(value) => updateOption(row.key, value)}
                  placeholder={`Option ${index + 1}`}
                  placeholderTextColor={colors.textFaint}
                  style={[styles.input, styles.optionInput]}
                  maxLength={80}
                  accessibilityLabel={`Option ${index + 1}`}
                />
                <Pressable
                  onPress={() => removeOption(row.key)}
                  disabled={!canRemoveOption}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove option ${index + 1}`}
                  accessibilityState={{ disabled: !canRemoveOption }}
                  style={[styles.removeBtn, !canRemoveOption && styles.removeBtnDisabled]}
                >
                  <Text style={[styles.removeGlyph, !canRemoveOption && styles.mutedText]}>−</Text>
                </Pressable>
              </View>
            ))}

            <Pressable
              onPress={addOption}
              disabled={!canAddOption}
              accessibilityRole="button"
              accessibilityLabel="Add option"
              accessibilityState={{ disabled: !canAddOption }}
              style={[styles.addBtn, !canAddOption && styles.addBtnDisabled]}
            >
              <Text style={[styles.addGlyph, !canAddOption && styles.mutedText]}>+</Text>
              <Text style={[styles.addLabel, !canAddOption && styles.mutedText]}>Add option</Text>
            </Pressable>

            <View style={styles.divider} />

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Allow multiple answers</Text>
              <Switch
                value={multi}
                onValueChange={setMulti}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor={colors.logoWhite}
                accessibilityLabel="Allow multiple answers"
              />
            </View>

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Anonymous poll</Text>
              <Switch
                value={anonymous}
                onValueChange={setAnonymous}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor={colors.logoWhite}
                accessibilityLabel="Anonymous poll"
              />
            </View>
            {anonymous && <Text style={styles.caption}>Votes will be counted, but nobody can see who voted.</Text>}

            <View style={styles.divider} />

            <Text style={styles.label}>Closes</Text>
            <View style={styles.chipRow}>
              {CLOSE_OPTIONS.map((opt) => {
                const active = closeChoice === opt.key;
                return (
                  <Pressable
                    key={opt.key}
                    onPress={() => setCloseChoice(opt.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Close poll: ${opt.label}`}
                    accessibilityState={{ selected: active }}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              onPress={submit}
              disabled={!canCreate}
              accessibilityRole="button"
              accessibilityLabel="Create poll"
              accessibilityState={{ disabled: true }}
              style={[styles.createBtn, !canCreate && styles.createBtnDisabled]}
            >
              <Text style={[styles.createLabel, !canCreate && styles.createLabelDisabled]}>Create poll</Text>
            </Pressable>

            {hint !== null && <Text style={styles.hint}>{hint}</Text>}
          </ScrollView>
        </Pressable>
      </Pressable>
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
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    maxHeight: '88%',
  },
  grabber: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  title: {
    ...type.heading,
    color: colors.text,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  closeGlyph: {
    color: colors.textMuted,
    fontSize: 22,
    lineHeight: 24,
  },
  label: {
    ...type.caption,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  counter: {
    ...type.micro,
    color: colors.textFaint,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.text,
    ...type.body,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  optionInput: {
    flex: 1,
    marginBottom: 0,
  },
  removeBtn: {
    width: 38,
    height: 38,
    marginLeft: spacing.sm,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  removeBtnDisabled: {
    backgroundColor: colors.surfaceInput,
  },
  removeGlyph: {
    color: colors.danger,
    fontSize: 20,
    lineHeight: 22,
  },
  mutedText: {
    color: colors.textFaint,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    marginTop: spacing.xs,
  },
  addBtnDisabled: {
    backgroundColor: colors.surfaceAlt,
  },
  addGlyph: {
    color: colors.accent,
    fontSize: 18,
    lineHeight: 20,
    marginRight: spacing.xs,
  },
  addLabel: {
    ...type.caption,
    color: colors.accent,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  switchLabel: {
    ...type.body,
    color: colors.text,
  },
  caption: {
    ...type.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceInput,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  },
  chipActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  chipText: {
    ...type.caption,
    color: colors.textMuted,
  },
  chipTextActive: {
    color: colors.accent,
  },
  createBtn: {
    marginTop: spacing.md,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.accent,
  },
  createBtnDisabled: {
    backgroundColor: colors.surfaceAlt,
  },
  createLabel: {
    ...type.heading,
    color: colors.bgDeep,
  },
  createLabelDisabled: {
    color: colors.textFaint,
  },
  hint: {
    ...type.caption,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
});
