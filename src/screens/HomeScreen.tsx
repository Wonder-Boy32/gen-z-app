import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import TabBar, { Tab } from '../components/TabBar';
import FeedScreen from './FeedScreen';
import CreateDropScreen from './CreateDropScreen';
import ProfileScreen from './ProfileScreen';
import ChatsScreen from './ChatsScreen';
import DiscoverScreen from './DiscoverScreen';
import { colors } from '../theme';

export default function HomeScreen() {
  const [tab, setTab] = useState<Tab>('feed');
  const [feedKey, setFeedKey] = useState(0);

  // cross-tab navigation targets (Discover -> feed filters)
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAudio, setPendingAudio] = useState<string | null>(null);
  const [pendingTag, setPendingTag] = useState<string | null>(null);

  const openFiltered = (user: string | null, audio: string | null, tag: string | null) => {
    setPendingUser(user);
    setPendingAudio(audio);
    setPendingTag(tag);
    setFeedKey((k) => k + 1); // remount feed with the new filter
    setTab('feed');
  };

  const handlePosted = () => {
    setFeedKey((k) => k + 1); // remount feed so it refetches
    setTab('feed');
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {tab === 'feed' && (
          <FeedScreen
            key={feedKey}
            initialUserMode={pendingUser}
            initialAudioMode={pendingAudio}
            initialHashtagMode={pendingTag}
            onJoinDrop={() => setTab('post')}
          />
        )}
        {tab === 'discover' && (
          <DiscoverScreen
            onOpenUser={(id) => openFiltered(id, null, null)}
            onOpenAudio={(a) => openFiltered(null, a, null)}
            onOpenTag={(t) => openFiltered(null, null, t)}
            onJoinDrop={() => setTab('post')}
          />
        )}
        {tab === 'post' && <CreateDropScreen onPosted={handlePosted} />}
        {tab === 'chat' && <ChatsScreen />}
        {tab === 'profile' && <ProfileScreen />}
      </View>
      <TabBar tab={tab} onChange={setTab} />
      <Text style={styles.devTag} pointerEvents="none">
        v4fe1b45-guard
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
  },
  devTag: {
    position: 'absolute',
    top: 34,
    left: 10,
    fontSize: 9,
    color: 'rgba(255,255,255,0.35)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
});
