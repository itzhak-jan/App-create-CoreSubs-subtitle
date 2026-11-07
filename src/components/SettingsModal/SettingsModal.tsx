import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import {useSettingsStore, LANGUAGES} from '../../store/settingsStore';
import type {AppSettings, TranslationEngine} from '../../types';

interface SettingsModalProps {
  visible: boolean;
  onClose: () => void;
  /** Called after a setting actually changed. */
  onChanged: (prev: AppSettings, next: AppSettings) => void;
}

const ENGINES: Array<{id: TranslationEngine; label: string; note: string}> = [
  {
    id: 'mlkit',
    label: 'Fast (ML Kit)',
    note: 'Milliseconds per line. ~30 MB per language, downloaded once.',
  },
  {
    id: 'llm',
    label: 'Gemma (LLM)',
    note: 'Slower, ~500 MB. Follows name gender hints.',
  },
];

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export function SettingsModal({
  visible,
  onClose,
  onChanged,
}: SettingsModalProps): React.JSX.Element {
  const settings = useSettingsStore();

  const change = async (partial: Partial<AppSettings>) => {
    const prev: AppSettings = {
      engine: settings.engine,
      targetLang: settings.targetLang,
      sourceLang: settings.sourceLang,
    };
    const next = {...prev, ...partial};
    if (
      next.engine === prev.engine &&
      next.targetLang === prev.targetLang &&
      next.sourceLang === prev.sourceLang
    ) {
      return;
    }
    await settings.update(partial);
    onChanged(prev, next);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView>
            <Text style={styles.title}>Subtitle settings</Text>

            <Text style={styles.section}>Translation engine</Text>
            {ENGINES.map(e => (
              <TouchableOpacity
                key={e.id}
                onPress={() => change({engine: e.id})}
                style={[
                  styles.engine,
                  settings.engine === e.id && styles.engineActive,
                ]}>
                <Text style={styles.engineLabel}>{e.label}</Text>
                <Text style={styles.engineNote}>{e.note}</Text>
              </TouchableOpacity>
            ))}

            <Text style={styles.section}>Subtitles in</Text>
            <View style={styles.row}>
              {LANGUAGES.map(l => (
                <Chip
                  key={l.code}
                  label={l.label}
                  active={settings.targetLang === l.code}
                  onPress={() => change({targetLang: l.code})}
                />
              ))}
            </View>

            <Text style={styles.section}>Spoken language</Text>
            <View style={styles.row}>
              <Chip
                label="Auto-detect"
                active={settings.sourceLang === 'auto'}
                onPress={() => change({sourceLang: 'auto'})}
              />
              {LANGUAGES.map(l => (
                <Chip
                  key={l.code}
                  label={l.label}
                  active={settings.sourceLang === l.code}
                  onPress={() => change({sourceLang: l.code})}
                />
              ))}
            </View>
            <Text style={styles.hint}>
              Non-English audio needs a multilingual Whisper model (the
              English-only “.en” model always transcribes as English).
            </Text>
          </ScrollView>

          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#161616',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 18,
    maxHeight: '85%',
  },
  title: {color: '#FFF', fontSize: 18, fontWeight: '700', marginBottom: 8},
  section: {
    color: '#AAA',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  engine: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  engineActive: {borderColor: '#FFD700'},
  engineLabel: {color: '#FFF', fontWeight: '600'},
  engineNote: {color: '#888', fontSize: 12, marginTop: 2},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipActive: {borderColor: '#FFD700', backgroundColor: 'rgba(255,215,0,0.12)'},
  chipText: {color: '#CCC', fontSize: 13},
  chipTextActive: {color: '#FFD700', fontWeight: '600'},
  hint: {color: '#777', fontSize: 12, marginTop: 10},
  closeBtn: {
    marginTop: 14,
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: '#FFD700',
    borderRadius: 8,
  },
  closeText: {color: '#000', fontWeight: '700'},
});
