// src/types/native-modules.d.ts

// Import NativeModule type if you want to be very explicit,
// or rely on its implicit presence when using NativeEventEmitter.
// For clarity, we can extend a base NativeModule type that includes emitter methods.

// A more generic type for modules that can emit events
interface NativeEventEmitterModule {
    addListener: (eventType: string) => void;
    removeListeners: (count: number) => void;
  }
  
  declare module 'react-native' {
    interface NativeModulesStatic {
      // EwonicAudioModule will have its own methods AND the event emitter methods
      EwonicAudioModule: EwonicAudioModuleInterface;
    }
  }
  
  export interface EwonicAudioModuleInterface extends NativeEventEmitterModule { // Extend here
    /**
     * Initializes the audio module with specific parameters.
     * Must be called before starting capture or playback.
     * @param sampleRate Sample rate in Hz (e.g., 16000).
     * @param bufferSize Preferred buffer size in frames.
     * @param channels Number of audio channels (1 for mono, 2 for stereo).
     * @param bitDepth Bit depth (e.g., 16 for 16-bit audio).
     * @returns Promise<void>
     */
    initialize(
      sampleRate: number,
      bufferSize: number,
      channels: number,
      bitDepth: number,
    ): Promise<void>;
  
    /**
     * Starts audio capture.
     * Captured audio data will be sent via the 'onAudioData' event.
     * @returns Promise<void>
     */
    startCapture(): Promise<void>;
  
    /**
     * Stops audio capture.
     * @returns Promise<void>
     */
    stopCapture(): Promise<void>;
  
    /**
     * Plays raw PCM audio data.
     * @param pcmDataBase64 Base64 encoded string of PCM audio data.
     * @returns Promise<void>
     */
    playAudio(pcmDataBase64: string): Promise<void>;
  
    /**
     * Cleans up resources used by the audio module.
     * Call when the module is no longer needed (e.g., on component unmount or app shutdown).
     * @returns Promise<void>
     */
    cleanup(): Promise<void>;
  
    // The addListener and removeListeners methods are now inherited from NativeEventEmitterModule.
    // No need to redefine them here unless you need to override their signatures, which is rare.
  }