import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import LobbyScreen from './screens/LobbyScreen';
import ConversationScreen from './screens/ConversationScreen';
import TrackPlayer from 'react-native-track-player';

function App(): React.JSX.Element {
  const [activePeerId, setActivePeerId] = useState<string | null>(null);

  useEffect(() => {
    TrackPlayer.setupPlayer();
    // No need for TrackPlayer.destroy (doesn't exist), optionally reset on unmount if you want:
    return () => {
      TrackPlayer.reset();
    };
  }, []);

  if (activePeerId) {
    return (
      <ConversationScreen
        peerId={activePeerId}
        onEndConversation={() => setActivePeerId(null)}
      />
    );
  }

  return (
    <LobbyScreen onPeerConnected={setActivePeerId} />
  );
}

const styles = StyleSheet.create({
  // ... (if needed, but not required for logic)
});

export default App;