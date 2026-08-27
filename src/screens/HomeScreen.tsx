import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../supabase/client';
import { parseAnonLink } from '../utils/deeplink';
import AnonymousSendScreen from './AnonymousSendScreen';
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

  // create-intent routing: sound page / reply-with-drop / anon card -> create tab
  const [createIntent, setCreateIntent] = useState<{ sound?: string; replyTo?: string; mediaUri?: string } | null>(null);

  const handleCreateIntent = (intent: { sound?: string; replyTo?: string; mediaUri?: string }) => {
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

  // ---- deep links: genz://anon/@user and https://genz.app/anon/@user ----
  const [anonDraft, setAnonDraft] = useState<string | null>(null); // username from the link
  const [anonRecipient, setAnonRecipient] = useState<{ id: string; name: string } | null>(null);

  const resolveAnonLink = async (username: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('id, username')
      .or(`username.eq.${username},username.eq.${username.toLowerCase()}`)
      .maybeSingle();
    if (data?.id) {
      setAnonRecipient({ id: data.id, name: data.username ?? username });
    } else {
      setAnonDraft(null);
    }
  };

  useEffect(() => {
    const handleUrl = (e: { url: string }) => {
      const name = parseAnonLink(e.url);
      if (name) {
        setAnonDraft(name);
        resolveAnonLink(name);
      }
    };
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl({ url });
    });
    const sub = Linking.addEventListener('url', handleUrl);
    return () => sub.remove();
  }, []);

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
            initialMediaUri={createIntent?.mediaUri ?? null}
          />
        )}
        {tab === 'chat' && (
          <ChatsScreen
            onOpenUser={(id) => openFiltered(id, null, null)}
            onOpenCreate={() => handleCreateIntent({})}
            onPostToFeed={(uri) => handleCreateIntent({ mediaUri: uri })}
          />
        )}
        {tab === 'profile' && (
          <ProfileScreen
            onOpenDropsFeed={(userId) => {
              setPendingUser(userId);
              setTab('feed');
            }}
            onPostToFeed={(uri) => handleCreateIntent({ mediaUri: uri })}
          />
        )}
      </View>
      <TabBar tab={tab} onChange={setTab} />

      {/* deep-link anonymous send overlay (opens from a link, any tab, cold start) */}
      {(anonDraft || anonRecipient) && (
        <View style={styles.anonOverlay}>
          {anonRecipient ? (
            <AnonymousSendScreen
              recipientId={anonRecipient.id}
              recipientName={anonRecipient.name}
              onBack={() => {
                setAnonDraft(null);
                setAnonRecipient(null);
              }}
            />
          ) : (
            <View style={styles.anonLoading}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.anonLoadingText}>Opening anonymous send…</Text>
            </View>
          )}
        </View>
      )}
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
  anonOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    backgroundColor: colors.bg,
  },
  anonLoading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  anonLoadingText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
});
