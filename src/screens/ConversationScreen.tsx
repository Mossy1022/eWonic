// eWonic/src/screens/ConversationScreen.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Button, StyleSheet, Platform, Alert } from 'react-native';
import { Buffer } from 'buffer';

import {
  start_audio_capture,
  stop_audio_capture,
  cleanup_audio_system, // Import the new cleanup function
} from '../services/audio/audio_capture';
import {
  // send_audio_frame, // This function in connection_manager sends text prefixed with "AUDIO:"
  send_binary_audio_frame, // Use this for iOS raw bytes, and connection_manager will handle Android b64
  cleanupManager as cleanupConnectionManager, // Renamed for clarity
} from '../services/p2p/connection_manager';
// The audio_receiver part is typically handled at a higher level or in the connection_manager
// when messages arrive, not directly in ConversationScreen for outgoing audio.
// However, if this screen also *plays* audio, you'd import from audio_receiver.
// For now, assuming this screen is primarily for *sending* audio.

import InCallManager from 'react-native-incall-manager';

interface ConversationScreenProps {
  peerId: string;
  onEndConversation?: () => void;
}

export default function ConversationScreen({
  peerId,
  onEndConversation,
}: ConversationScreenProps) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoading, setIsLoading] = useState(false); // For async operations

  // --- Audio and InCallManager Setup ---
  useEffect(() => {
    console.log('[ConversationScreen] Mounting. Setting up InCallManager.');
    InCallManager.start({ media: 'audio' });
    InCallManager.setForceSpeakerphoneOn(true); // Or false, depending on preference

    // Cleanup InCallManager and our custom audio system on unmount
    return () => {
      console.log('[ConversationScreen] Unmounting. Stopping InCallManager and cleaning up audio system.');
      InCallManager.stop();
      // Ensure audio capture is stopped if it was running
      if (isStreaming) { // Check component's state, though stop_audio_capture has its own checks
        stop_audio_capture().catch(err => console.error("Error stopping audio capture on unmount:", err));
      }
      cleanup_audio_system().catch(err => console.error("Error cleaning up audio system on unmount:", err));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // isStreaming dependency removed to avoid re-triggering cleanup logic on stream state change

  // --- Connection Manager Cleanup ---
  useEffect(() => {
    // This effect is solely for cleaning up the connection manager when the screen unmounts
    // or peerId changes (though usually onEndConversation would trigger unmount before peerId changes)
    return () => {
      console.log('[ConversationScreen] Cleaning up ConnectionManager.');
      cleanupConnectionManager().catch(err => console.error("Error cleaning up connection manager:", err));
    };
  }, []); // Empty dependency array means this cleanup runs once on unmount

  const handleStartStreaming = useCallback(async () => {
    if (isStreaming) return;
    setIsLoading(true);
    console.log('[ConversationScreen] Attempting to start audio streaming...');
    try {
      await start_audio_capture((frame: Uint8Array) => {
        console.log(`[ConversationScreen] onFrame callback triggered. Frame size: ${frame.byteLength}`);

        // This callback is synchronous from the perspective of start_audio_capture's promise,
        // but the sending of the frame can be async.
        if (!peerId) {
          console.warn('[ConversationScreen] No peerId to send audio frame to.');
          return;
        }
        // Use send_binary_audio_frame for iOS, which handles raw Uint8Array.
        // For Android, connection_manager's send_binary_audio_frame internally
        // converts to base64 and uses send_audio_frame (which prefixes "AUDIO:").
        send_binary_audio_frame(frame, peerId)
        .then(() => {
          console.log(`[ConversationScreen] Successfully called send_binary_audio_frame for peer ${peerId}`); // Can be noisy
        })
        .catch(err => console.error(`[ConversationScreen] Error sending audio frame to ${peerId}:`, err));
      });
      setIsStreaming(true);
      console.log('[ConversationScreen] Audio streaming started successfully.');
    } catch (error) {
      console.error('[ConversationScreen] Failed to start audio streaming:', error);
      Alert.alert("Error", "Could not start audio streaming.");
    } finally {
      setIsLoading(false);
    }
  }, [isStreaming, peerId]);

  const handleStopStreaming = useCallback(async () => {
    if (!isStreaming) return;
    setIsLoading(true);
    console.log('[ConversationScreen] Attempting to stop audio streaming...');
    try {
      await stop_audio_capture();
      setIsStreaming(false);
      console.log('[ConversationScreen] Audio streaming stopped successfully.');
    } catch (error) {
      console.error('[ConversationScreen] Failed to stop audio streaming:', error);
      Alert.alert("Error", "Could not stop audio streaming.");
    } finally {
      setIsLoading(false);
    }
  }, [isStreaming]);

  const handleEndConversationPress = () => {
    if (onEndConversation) {
      onEndConversation();
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        Conversation with peer: {peerId ? peerId.slice(0, 8) : 'Unknown'}
      </Text>
      <View style={styles.buttonContainer}>
        <Button
          title={isLoading ? "Processing..." : (isStreaming ? 'Stop Streaming Audio' : 'Start Streaming Audio')}
          onPress={isStreaming ? handleStopStreaming : handleStartStreaming}
          disabled={isLoading}
        />
      </View>
      {onEndConversation && (
        <View style={[styles.buttonContainer, styles.endButtonContainer]}>
          <Button
            title="End Conversation"
            onPress={handleEndConversationPress}
            color="#FF3B30" // Red color for ending
            disabled={isLoading}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#f0f0f0', // Slightly different background
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
    color: '#333',
  },
  buttonContainer: {
    width: '80%',
    maxWidth: 320,
    marginVertical: 15,
  },
  endButtonContainer: {
      marginTop: 30,
  }
});