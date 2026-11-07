import React, {useState} from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
} from 'react-native';
import {useGlossaryStore} from '../../store/glossaryStore';
import {useSubtitleStore} from '../../store/subtitleStore';
import type {GlossaryEntry} from '../../types';

interface GlossaryModalProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * "Names" screen: every name/place/phrase the app has locked for this video.
 * Fixing a rendering here applies to all later subtitles AND rewrites the
 * ones already generated. Entries are saved per video.
 */
export function GlossaryModal({
  visible,
  onClose,
}: GlossaryModalProps): React.JSX.Element {
  const entries = useGlossaryStore(s => s.entries);
  const {setUserEntry, removeEntry} = useGlossaryStore.getState();
  const [newTerm, setNewTerm] = useState('');
  const [newRendering, setNewRendering] = useState('');

  const list = Array.from(entries.values()).sort((a, b) =>
    a.term.localeCompare(b.term),
  );

  const save = (entry: GlossaryEntry, rendering: string) => {
    const r = rendering.trim();
    if (!r || r === entry.hebrew) {
      return;
    }
    const previous = setUserEntry({...entry, hebrew: r});
    if (previous) {
      useSubtitleStore.getState().replaceInCues(previous, r);
    }
  };

  const add = () => {
    if (!newTerm.trim() || !newRendering.trim()) {
      return;
    }
    const term = newTerm.trim();
    const previous = setUserEntry({
      term,
      hebrew: newRendering.trim(),
      // A lowercase or multi-word entry is most likely a phrase, which
      // matches case-insensitively.
      category:
        term[0] === term[0].toUpperCase() && !term.includes(' ')
          ? undefined
          : 'phrase',
    });
    if (previous) {
      useSubtitleStore.getState().replaceInCues(previous, newRendering.trim());
    }
    setNewTerm('');
    setNewRendering('');
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Names & phrases</Text>
          <Text style={styles.subtitle}>
            Locked so every subtitle spells them the same. Fix one and all
            subtitles update.
          </Text>

          <FlatList
            data={list}
            keyExtractor={e => e.term.toLowerCase()}
            style={styles.list}
            ListEmptyComponent={
              <Text style={styles.empty}>
                Nothing yet — names are added automatically once they appear
                twice.
              </Text>
            }
            renderItem={({item}) => (
              <View style={styles.item}>
                <Text style={styles.term} numberOfLines={1}>
                  {item.term}
                  {item.origin === 'user' ? '  ✓' : ''}
                </Text>
                <TextInput
                  defaultValue={item.hebrew}
                  onEndEditing={e => save(item, e.nativeEvent.text)}
                  style={styles.input}
                  placeholderTextColor="#666"
                />
                <TouchableOpacity
                  onPress={() => removeEntry(item.term)}
                  style={styles.remove}>
                  <Text style={styles.removeText}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
          />

          <View style={styles.item}>
            <TextInput
              value={newTerm}
              onChangeText={setNewTerm}
              placeholder="Original (e.g. Jon Snow)"
              placeholderTextColor="#666"
              style={[styles.input, styles.addInput]}
            />
            <TextInput
              value={newRendering}
              onChangeText={setNewRendering}
              placeholder="In subtitles"
              placeholderTextColor="#666"
              style={styles.input}
            />
            <TouchableOpacity onPress={add} style={styles.remove}>
              <Text style={styles.addText}>＋</Text>
            </TouchableOpacity>
          </View>

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
  title: {color: '#FFF', fontSize: 18, fontWeight: '700'},
  subtitle: {color: '#888', fontSize: 12, marginTop: 4, marginBottom: 10},
  list: {flexGrow: 0},
  empty: {color: '#777', fontSize: 13, paddingVertical: 16},
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  term: {color: '#DDD', fontSize: 14, flex: 1},
  input: {
    flex: 1,
    color: '#FFF',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  addInput: {textAlign: 'left', writingDirection: 'ltr'},
  remove: {paddingHorizontal: 8, paddingVertical: 4},
  removeText: {color: '#C55', fontSize: 16},
  addText: {color: '#FFD700', fontSize: 20, fontWeight: '700'},
  closeBtn: {
    marginTop: 14,
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: '#FFD700',
    borderRadius: 8,
  },
  closeText: {color: '#000', fontWeight: '700'},
});
