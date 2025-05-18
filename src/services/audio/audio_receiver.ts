// src/services/audio/audio_receiver.ts
import { NativeModules, Platform } from 'react-native';
import { Buffer } from 'buffer';

// This is the crucial part: Use your new native module
const { EwonicAudioModule } = NativeModules;
let isAudioPlayerInitialized = false;

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BUFFER_SIZE = 1024;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BIT_DEPTH = 16;

async function initializeAudioPlayerSystem(): Promise<void> {
  if (isAudioPlayerInitialized) {
    return;
  }
  try {
    await EwonicAudioModule.initialize( // Using EwonicAudioModule
      DEFAULT_SAMPLE_RATE,
      DEFAULT_BUFFER_SIZE,
      DEFAULT_CHANNELS,
      DEFAULT_BIT_DEPTH,
    );
    isAudioPlayerInitialized = true;
    console.log('[AudioReceiver] EwonicAudioModule (player part) initialized.');
  } catch (error) {
    console.error('[AudioReceiver] Failed to initialize EwonicAudioModule for playback:', error);
    throw error;
  }
}

export async function handle_incoming_audio_frame(
  frame: string | Uint8Array,
): Promise<void> {
  if (!isAudioPlayerInitialized) {
    try {
      await initializeAudioPlayerSystem();
    } catch (error) {
      console.error('[AudioReceiver] Initialization failed, cannot play audio frame.');
      return;
    }
  }

  let pcmDataBase64: string;

  if (typeof frame === 'string') {
    pcmDataBase64 = frame;
  } else if (frame instanceof Uint8Array) {
    pcmDataBase64 = Buffer.from(frame).toString('base64');
  } else {
    console.error('[AudioReceiver] Invalid audio frame type:', typeof frame);
    return;
  }

  if (!pcmDataBase64 || pcmDataBase64.length === 0) {
      console.warn('[AudioReceiver] Attempted to play an empty audio frame.');
      return;
  }

  try {
    // Calling your new native module's method
    await EwonicAudioModule.playAudio(pcmDataBase64);
  } catch (error) {
    console.error('[AudioReceiver] Error playing audio frame:', error);
  }
}

export async function cleanup_audio_player_system(): Promise<void> {
  if (isAudioPlayerInitialized) {
    try {
      await EwonicAudioModule.cleanup(); // Using EwonicAudioModule
      isAudioPlayerInitialized = false;
      console.log('[AudioReceiver] EwonicAudioModule (player part) cleaned up.');
    } catch (error) {
      console.error('[AudioReceiver] Failed to cleanup EwonicAudioModule (player part):', error);
    }
  }
}