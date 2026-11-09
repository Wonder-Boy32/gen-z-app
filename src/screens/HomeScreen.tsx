import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../supabase/client';
import { parseAnonLink } from '../utils/deeplink';
import AnonymousSendScreen from './AnonymousSendScreen';
import NeonDock from '../components/ui/NeonDock';
import type { Tab } from '../components/TabBar';
import FeedScreen from './FeedScreen';
import CreateFlow, { type CreateIntent } from '../create/CreateFlow';
import ProfileScreen from './ProfileScreen';
import ChatsScreen from './ChatsScreen';
import DiscoverScreen from './DiscoverScreen';
import ExploreScreen from './ExploreScreen';
import UploadBar from '../components/ui/UploadBar';
import { colors } from '../theme';
import { useAndroidBack } from '../utils/useAndroidBack';
import { useUploads } from '../utils/uploadManager';
import { useHasDraft } from '../utils/draftStore';

export default function HomeScreen({ openActivitySignal = 0 }: { openActivitySignal?: number }) {
  const [tab, setTab] = useState<Tab>('feed');
  const [feedKey, setFeedKey] = useState(0);
  const [chatUnread, setChatUnread] = useState(0);
  // saved create work, so the + button can say so from any tab
  const hasDraft = useHasDraft();

  // The dock is a navigation surface, not furniture: while a keyboard is up it
  // has no business occupying the bottom of the screen, and on a short phone it
  // would push a composer into the top half. It is unmounted rather than hidden
  // so the space it took goes back to whatever is being typed into.
  //
  // Platform-specific events on purpose — `keyboardDidShow` does not exist on
  // iOS, and `keyboardWillShow` does not exist on Android.
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, () => setKeyboardUp(true));
    const h = Keyboard.addListener(hideEvt, () => setKeyboardUp(false));
    return () => {
      s.remove();
      h.remove();
    };
  }, []);

  // Android back at the tab level: step back to the Feed tab rather than letting
  // the press close the app from Discover, Chat or Profile. Returning false on
  // Feed — the root — is what still allows Android to exit from there.
  //
  // Ordering is handled by BackHandler itself: ChatsScreen registers later in
  // the tree and BackHandler runs the NEWEST listener first, so an open thread
  // is closed before this handler ever sees the press.
  useAndroidBack(() => {
    if (tab !== 'feed') {
      setTab('feed');
      return true;
    }
    return false;
  });

  // cross-tab navigation targets (Discover -> feed filters)
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAudio, setPendingAudio] = useState<string | null>(null);
  const [pendingTag, setPendingTag] = useState<string | null>(null);
  const [pendingLocation, setPendingLocation] = useState<string | null>(null);

  // CREATE IS NOT A TAB ANY MORE.
  //
  // It used to be: tapping + set tab='post', which unmounted whatever you were
  // on and mounted a four-step wizard in the tab's slot. That made the + button
  // a place, and "back" had to be re-derived at two levels.
  //
  // Now + opens the create flow as an overlay. The tabs underneath never
  // change, so leaving the flow puts you back exactly where you were, and the
  // flow owns its own navigation end to end (see src/create/flow.ts).
  const [createOpen, setCreateOpen] = useState(false);
  // create-intent routing: sound page / reply-with-drop / shared media
  const [createIntent, setCreateIntent] = useState<CreateIntent | null>(null);
  // Explore is a page, not a tab: it is a detour from the feed, so it opens over
  // the tabs and closes back to whichever one you came from.
  const [exploreOpen, setExploreOpen] = useState(false);

  const openCreate = (intent: CreateIntent | null = null) => {
    setCreateIntent(intent);
    setCreateOpen(true);
  };

  const handleCreateIntent = (intent: CreateIntent) => openCreate(intent);

  const openFiltered = (user: string | null, audio: string | null, tag: string | null) => {
    setPendingUser(user);
    setPendingAudio(audio);
    setPendingTag(tag);
    setPendingLocation(null); // the filters are mutually exclusive
    setFeedKey((k) => k + 1); // remount feed with the new filter
    setTab('feed');
  };

  /**
   * A place filter, opened by searching a location in Discover or tapping a
   * location label. Works exactly like the tag filter: the feed is remounted
   * with locationMode set and its own query branch does the work, so there is
   * one implementation of "posts from somewhere" rather than two.
   */
  const openLocation = (place: string) => {
    setPendingUser(null);
    setPendingAudio(null);
    setPendingTag(null);
    setPendingLocation(place);
    setFeedKey((k) => k + 1);
    setTab('feed');
  };

  const handlePosted = () => {
    setCreateIntent(null);
    setCreateOpen(false);
    setFeedKey((k) => k + 1); // remount feed so it refetches
    setTab('feed');
  };

  // "See what's happening now" in the launcher: the flow gets out of the way
  // and drops you on the live feed, without pretending to be a cancel.
  const handleSeeLive = () => {
    setCreateIntent(null);
    setCreateOpen(false);
    setTab('feed');
  };

  // Posting is now background work, so the feed was remounted BEFORE the post
  // existed. Refresh it once the upload actually lands, otherwise the user's own
  // new drop is missing from the feed they were just sent back to.
  const uploads = useUploads();
  const uploadsDone = uploads.filter((u) => u.status === 'done').length;
  const postedRefreshRef = React.useRef(0);
  useEffect(() => {
    if (uploadsDone > postedRefreshRef.current) setFeedKey((k) => k + 1);
    postedRefreshRef.current = uploadsDone;
  }, [uploadsDone]);

  // ---- deep links: genz://anon/@user and https://genz.app/anon/@user ----
  const [anonDraft, setAnonDraft] = useState<string | null>(null); // username from the link
  const [anonRecipient, setAnonRecipient] = useState<{ id: string; name: string } | null>(null);

  // Android back for the anonymous-send overlay. It sits ABOVE the tab host and
  // is a plain <View> overlay, not a <Modal>, so RN's onRequestClose never
  // covered it: the press fell through to the tab handler below (popping to the
  // Feed tab) while the overlay stayed open on top. Registered after that
  // handler, and BackHandler runs the newest listener first, so this one takes
  // the press while the overlay is up and declines otherwise.
  useAndroidBack(() => {
    if (!anonRecipient && !anonDraft) return false;
    setAnonRecipient(null);
    setAnonDraft(null);
    return true;
  });

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
          initialLocationMode={pendingLocation}
          focused={tab === 'feed'}
           onJoinDrop={() => openCreate(null)}
           onCreateIntent={handleCreateIntent}
           openActivitySignal={openActivitySignal}
           onOpenExplore={() => setExploreOpen(true)}
           onOpenSearch={() => setTab('discover')}
           onOpenChat={() => setTab('chat')}
           chatUnread={tab === 'chat' ? 0 : chatUnread}
         />
      </View>
      <View style={[styles.content, tab !== 'discover' && styles.hiddenTab]}>
        <DiscoverScreen
          onOpenUser={(id) => openFiltered(id, null, null)}
          onOpenAudio={(a) => openFiltered(null, a, null)}
          onOpenTag={(t) => openFiltered(null, null, t)}
           onOpenLocation={openLocation}
           onJoinDrop={() => openCreate(null)}
         />
      </View>
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
      {/* ambient upload status — sits just above the tab bar so it can never
          cover navigation, and hides itself when there is nothing to report */}
      <UploadBar />

      {/* The create flow, above everything including the dock. Full-screen on
          purpose: the camera has no business sharing the screen with a tab bar,
          and the flow carries its own exits. */}
      <CreateFlow
        visible={createOpen}
        intent={createIntent}
        hasDraft={hasDraft}
        onClose={() => {
          setCreateIntent(null);
          setCreateOpen(false);
        }}
        onPosted={handlePosted}
        onSeeLive={handleSeeLive}
      />

      {/* unread badge hidden while you're already in the Chat tab (WhatsApp style) */}
      {!keyboardUp && !createOpen && (
        <NeonDock
          tab={tab}
          onChange={(t) => {
            // + is a verb, not a place: it opens the flow and leaves the tab
            // underneath exactly as it was.
            if (t === 'post') {
              openCreate(null);
              return;
            }
            setTab(t);
          }}
          badges={{ chat: tab === 'chat' ? 0 : chatUnread }}
          hasDraft={hasDraft}
        />
      )}

      {/* Explore: the Drop banner, Create, Invite and people suggestions that
          used to float over the video in the feed. Sits above the dock so it
          reads as a page rather than a tab. */}
      {exploreOpen && (
        <View style={styles.exploreOverlay}>
          <ExploreScreen
            onCreate={() => {
              setExploreOpen(false);
              handleCreateIntent({});
            }}
            onSearch={() => {
              setExploreOpen(false);
              setTab('discover');
            }}
            onJoinDrop={(dropId) => {
              // Entering a Drop is a post to it, which is what replyToDropId
              // means downstream — the same path chain replies already take.
              setExploreOpen(false);
              handleCreateIntent({ replyTo: dropId });
            }}
            onOpenUser={(id) => {
              setExploreOpen(false);
              openFiltered(id, null, null);
            }}
            onClose={() => setExploreOpen(false)}
          />
        </View>
      )}

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
  exploreOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 60,
    backgroundColor: colors.bg,
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
