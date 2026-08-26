import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
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

  // create-intent routing: sound page / reply-with-drop -> create tab
  const [createIntent, setCreateIntent] = useState<{ sound?: string; replyTo?: string } | null>(null);

  const handleCreateIntent = (intent: { sound?: string; replyTo?: string }) => {
    setCreateIntent(intent);
    setTab('post');
  };

  const openFiltered = (user: string | null, audio: string | null, tag: string | null) => {
    setPendingUser(user);
    setPendingAudio(audio);
    setPendingTag(tag);
    setFeedKey((k) => k + 1); // remount feed with the new filter
    setTab('feed');
  };

  const handlePosted = () => {
    setCreateIntent(null);
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
            onCreateIntent={handleCreateIntent}
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
        {tab === 'post' && (
          <CreateDropScreen
            onPosted={handlePosted}
            initialSound={createIntent?.sound ?? null}
            replyToDropId={createIntent?.replyTo ?? null}
          />
        )}
        {tab === 'chat' && <ChatsScreen />}
        {tab === 'profile' && <ProfileScreen />}
      </View>
      <TabBar tab={tab} onChange={setTab} />
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
});
