// src/services/audio/audio_capture.ts
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import { Buffer } from 'buffer';

const { EwonicAudioModule } = NativeModules;
const audioEventEmitter = new NativeEventEmitter(EwonicAudioModule);

let audioDataSubscription: any | null = null;

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BUFFER_SIZE = 1024;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BIT_DEPTH = 16;

let isCapturing = false;
let isInitialized = false; // Tracks initialization state for the audio system

/**
 * Initializes the native audio module.
 */
async function initializeAudioSystem(): Promise<void> {
  if (isInitialized) {
    return;
  }
  try {
    // Ensure EwonicAudioModule and its methods exist
    if (!EwonicAudioModule || typeof EwonicAudioModule.initialize !== 'function') {
        console.error('[AudioCapture] EwonicAudioModule or initialize method is not available. Check native module linking.');
        throw new Error('EwonicAudioModule not available');
    }
    await EwonicAudioModule.initialize(
      DEFAULT_SAMPLE_RATE,
      DEFAULT_BUFFER_SIZE,
      DEFAULT_CHANNELS,
      DEFAULT_BIT_DEPTH,
    );
    isInitialized = true;
    console.log('[AudioCapture] EwonicAudioModule initialized.');
  } catch (error) {
    console.error('[AudioCapture] Failed to initialize EwonicAudioModule:', error);
    throw error;
  }
}

/**
 * Begin streaming mic audio.
 * @param onFrame Callback function to handle incoming audio frames (as Uint8Array).
 */
export async function start_audio_capture(
  onFrame: (pcm: Uint8Array) => void,
): Promise<void> {
  if (isCapturing) {
    console.log('[AudioCapture] Audio capture is already active.');
    return;
  }
  if (!isInitialized) {
    // Automatically initialize if not done yet.
    // Consider if explicit initialization from app start is better.
    console.log('[AudioCapture] Audio system not initialized. Initializing now...');
    await initializeAudioSystem();
  }

  if (audioDataSubscription) {
    audioDataSubscription.remove();
    audioDataSubscription = null;
  }

  audioDataSubscription = audioEventEmitter.addListener(
    'onAudioData', // This event name must match what your native module emits
    (eventPayload: { data: string }) => { // Assuming body is @{@"data": base64Data}
      // ADD THIS LOG
      console.log('[AudioCapture JS] Received onAudioData event. Data length (base64):', eventPayload.data?.length);
      try {
        const pcmData = Buffer.from(eventPayload.data, 'base64');
        onFrame(new Uint8Array(pcmData));
      } catch (e) {
        console.error('[AudioCapture JS] Error processing audio data event:', e);
      }
    },
  );
  

  try {
    if (!EwonicAudioModule || typeof EwonicAudioModule.startCapture !== 'function') {
        console.error('[AudioCapture] EwonicAudioModule or startCapture method is not available.');
        throw new Error('EwonicAudioModule.startCapture not available');
    }
    await EwonicAudioModule.startCapture();
    isCapturing = true;
    console.log('[AudioCapture] Audio capture started.');
  } catch (error) {
    console.error('[AudioCapture] Failed to start audio capture:', error);
    audioDataSubscription?.remove();
    audioDataSubscription = null;
    throw error;
  }
}

/**
 * Stop streaming mic audio.
 */
export async function stop_audio_capture(): Promise<void> {
  if (!isCapturing) {
    return;
  }
  if (!isInitialized) {
    console.warn('[AudioCapture] Audio system not initialized, cannot stop capture properly.');
    isCapturing = false; // Reset flag even if not initialized
    audioDataSubscription?.remove();
    audioDataSubscription = null;
    return;
  }

  try {
    if (!EwonicAudioModule || typeof EwonicAudioModule.stopCapture !== 'function') {
        console.error('[AudioCapture] EwonicAudioModule or stopCapture method is not available.');
        throw new Error('EwonicAudioModule.stopCapture not available');
    }
    await EwonicAudioModule.stopCapture();
    isCapturing = false;
    console.log('[AudioCapture] Audio capture stopped.');
  } catch (error) {
    console.error('[AudioCapture] Failed to stop audio capture:', error);
    // Don't re-throw here, but ensure listener is removed.
  } finally {
    if (audioDataSubscription) {
      audioDataSubscription.remove();
      audioDataSubscription = null;
    }
  }
}

/**
 * Cleans up the audio module resources.
 */
export async function cleanup_audio_system(): Promise<void> {
  console.log('[AudioCapture] Attempting to clean up audio system...');
  if (isCapturing) {
    await stop_audio_capture(); // Ensure capture is stopped first
  }
  if (isInitialized) {
    try {
      if (!EwonicAudioModule || typeof EwonicAudioModule.cleanup !== 'function') {
        console.error('[AudioCapture] EwonicAudioModule or cleanup method is not available for cleanup.');
        // Set flags to allow re-initialization if app continues
        isInitialized = false;
        isCapturing = false; // Redundant if stop_audio_capture succeeded, but safe
        return;
      }
      await EwonicAudioModule.cleanup();
      isInitialized = false;
      console.log('[AudioCapture] EwonicAudioModule cleaned up.');
    } catch (error) {
      console.error('[AudioCapture] Failed to cleanup EwonicAudioModule:', error);
      // Even if cleanup fails, mark as not initialized to allow potential re-init
      isInitialized = false;
    }
  } else {
    console.log('[AudioCapture] Audio system was not initialized, no cleanup needed from here.');
  }
  // Ensure flags are reset
  isCapturing = false;
  if (audioDataSubscription) {
      audioDataSubscription.remove();
      audioDataSubscription = null;
  }
}