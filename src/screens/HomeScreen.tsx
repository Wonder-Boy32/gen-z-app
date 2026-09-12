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

export default function HomeScreen({ openActivitySignal = 0 }: { openActivitySignal?: number }) {
  const [tab, setTab] = useState<Tab>('feed');
  const [feedKey, setFeedKey] = useState(0);
  const [chatUnread, setChatUnread] = useState(0);

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
      {/* Keep-alive tabs: every main tab stays mounted and loads ONCE.
          Inactive tabs are hidden (display:none) instead of unmounted, so
          switching is instant and state (scroll, drafts, chat) survives. */}
      <View style={[styles.content, tab !== 'feed' && styles.hiddenTab]}>
        <FeedScreen
          key={feedKey}
          initialUserMode={pendingUser}
          initialAudioMode={pendingAudio}
          initialHashtagMode={pendingTag}
          focused={tab === 'feed'}
          onJoinDrop={() => setTab('post')}
          onCreateIntent={handleCreateIntent}
          openActivitySignal={openActivitySignal}
        />
      </View>
      <View style={[styles.content, tab !== 'discover' && styles.hiddenTab]}>
        <DiscoverScreen
          onOpenUser={(id) => openFiltered(id, null, null)}
          onOpenAudio={(a) => openFiltered(null, a, null)}
          onOpenTag={(t) => openFiltered(null, null, t)}
          onJoinDrop={() => setTab('post')}
        />
      </View>
      {/* the create tab stays lazy-mounted (camera/audio init) — it keeps its
          draft while open, and remounts fresh when reopened */}
      {tab === 'post' && (
        <CreateDropScreen
          onPosted={handlePosted}
          initialSound={createIntent?.sound ?? null}
          replyToDropId={createIntent?.replyTo ?? null}
          initialMediaUri={createIntent?.mediaUri ?? null}
        />
      )}
      <View style={[styles.content, tab !== 'chat' && styles.hiddenTab]}>
        <ChatsScreen
          onOpenUser={(id) => openFiltered(id, null, null)}
          onOpenCreate={() => handleCreateIntent({})}
          onPostToFeed={(uri) => handleCreateIntent({ mediaUri: uri })}
          onUnreadChange={setChatUnread}
        />
      </View>
      <View style={[styles.content, tab !== 'profile' && styles.hiddenTab]}>
        <ProfileScreen
          onOpenDropsFeed={(userId) => {
            setPendingUser(userId);
            setTab('feed');
          }}
          onPostToFeed={(uri) => handleCreateIntent({ mediaUri: uri })}
        />
      </View>
      {/* unread badge hidden while you're already in the Chat tab (WhatsApp style) */}
      <TabBar tab={tab} onChange={setTab} badges={{ chat: tab === 'chat' ? 0 : chatUnread }} />

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
  hiddenTab: {
    display: 'none',
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
