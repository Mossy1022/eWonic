// android/app/src/main/java/com/yourpackage/EwonicAudioModule.java
package com.ewonic; // Replace with your actual package name

import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.os.Process;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.module.annotations.ReactModule;
import com.facebook.react.modules.core.DeviceEventManagerModule;

@ReactModule(name = EwonicAudioModule.NAME)
public class EwonicAudioModule extends ReactContextBaseJavaModule {
    public static final String NAME = "EwonicAudioModule";
    private static final String TAG = "EwonicAudioModule";

    private AudioRecord audioRecord;
    private AudioTrack audioTrack;
    private Thread recordingThread;
    private Thread playbackThread; // Optional: if playback needs its own thread
    private boolean isRecording = false;
    private boolean isPlaying = false; // If managing playback state

    private int sampleRate = 16000;
    private int bufferSizeInBytesRecord;
    private int bufferSizeInBytesPlay;
    private int channelConfigRecord = AudioFormat.CHANNEL_IN_MONO;
    private int channelConfigPlay = AudioFormat.CHANNEL_OUT_MONO;
    private int audioFormat = AudioFormat.ENCODING_PCM_16BIT;

    public EwonicAudioModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @NonNull
    @Override
    public String getName() {
        return NAME;
    }

    private void sendEvent(String eventName, @Nullable WritableMap params) {
        getReactApplicationContext()
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(eventName, params);
    }

    @ReactMethod
    public void initialize(int sampleRate, int bufferSize, int channels, int bitDepth, Promise promise) {
        Log.d(TAG, "Initializing AudioModule: SR=" + sampleRate + ", BufSize=" + bufferSize + ", Ch=" + channels + ", Depth=" + bitDepth);
        this.sampleRate = sampleRate;

        if (channels == 1) {
            this.channelConfigRecord = AudioFormat.CHANNEL_IN_MONO;
            this.channelConfigPlay = AudioFormat.CHANNEL_OUT_MONO;
        } else if (channels == 2) {
            this.channelConfigRecord = AudioFormat.CHANNEL_IN_STEREO;
            this.channelConfigPlay = AudioFormat.CHANNEL_OUT_STEREO;
        } else {
            promise.reject("INIT_ERROR", "Unsupported channel count: " + channels);
            return;
        }

        if (bitDepth == 16) {
            this.audioFormat = AudioFormat.ENCODING_PCM_16BIT;
        } else if (bitDepth == 8) {
            this.audioFormat = AudioFormat.ENCODING_PCM_8BIT;
        } else {
            promise.reject("INIT_ERROR", "Unsupported bit depth: " + bitDepth);
            return;
        }

        // Use provided bufferSize if it's reasonable, otherwise calculate minimum
        int minRecordBufferSize = AudioRecord.getMinBufferSize(this.sampleRate, this.channelConfigRecord, this.audioFormat);
        this.bufferSizeInBytesRecord = Math.max(bufferSize, minRecordBufferSize); // `bufferSize` from JS is in frames, convert to bytes if needed. Assuming it's already bytes for simplicity here or it implies frame count. Let's assume it's frame count.
        // If bufferSize from JS is in frames:
        // this.bufferSizeInBytesRecord = Math.max(bufferSize * (bitDepth / 8) * channels, minRecordBufferSize);


        int minPlayBufferSize = AudioTrack.getMinBufferSize(this.sampleRate, this.channelConfigPlay, this.audioFormat);
        // If bufferSize from JS is in frames:
        // this.bufferSizeInBytesPlay = Math.max(bufferSize * (bitDepth / 8) * channels, minPlayBufferSize);
        this.bufferSizeInBytesPlay = Math.max(bufferSize, minPlayBufferSize); // Same assumption as above for simplicity


        Log.d(TAG, "Record Buffer Size: " + this.bufferSizeInBytesRecord + " bytes (Min: " + minRecordBufferSize + ")");
        Log.d(TAG, "Play Buffer Size: " + this.bufferSizeInBytesPlay + " bytes (Min: " + minPlayBufferSize + ")");

        try {
            // Permissions should be checked in React Native before calling initialize
            audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC,
                    this.sampleRate, this.channelConfigRecord, this.audioFormat, this.bufferSizeInBytesRecord);

            audioTrack = new AudioTrack(AudioManager.STREAM_MUSIC,
                    this.sampleRate, this.channelConfigPlay, this.audioFormat,
                    this.bufferSizeInBytesPlay, AudioTrack.MODE_STREAM);

            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                promise.reject("INIT_ERROR", "Failed to initialize AudioRecord");
                return;
            }
            if (audioTrack.getState() != AudioTrack.STATE_INITIALIZED) {
                promise.reject("INIT_ERROR", "Failed to initialize AudioTrack");
                return;
            }
            promise.resolve(null);
        } catch (SecurityException e) {
            promise.reject("INIT_ERROR", "Permission denied for AudioRecord: " + e.getMessage());
        } catch (Exception e) {
            promise.reject("INIT_ERROR", "Failed to initialize audio components: " + e.getMessage());
        }
    }

    @ReactMethod
    public void startCapture(Promise promise) {
        if (audioRecord == null || audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            promise.reject("CAPTURE_ERROR", "AudioRecord not initialized.");
            return;
        }
        if (isRecording) {
            promise.resolve(null); // Already recording
            return;
        }

        try {
            audioRecord.startRecording();
            isRecording = true;
            Log.d(TAG, "Audio recording started.");

            recordingThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
                    byte[] buffer = new byte[bufferSizeInBytesRecord]; // Or a smaller chunk size for emission
                    while (isRecording) {
                        int bytesRead = audioRecord.read(buffer, 0, buffer.length);
                        if (bytesRead > 0) {
                            // Send data to JS as Base64
                            String base64Data = Base64.encodeToString(buffer, 0, bytesRead, Base64.NO_WRAP);
                            WritableMap params = Arguments.createMap();
                            params.putString("data", base64Data);
                            sendEvent("onAudioData", params);
                        } else if (bytesRead < 0) {
                             Log.e(TAG, "AudioRecord read error: " + bytesRead);
                             // Optionally stop recording on error
                             // isRecording = false; // This would break the loop
                             // break;
                        }
                    }
                    Log.d(TAG, "Recording thread finished.");
                }
            });
            recordingThread.start();
            promise.resolve(null);
        } catch (Exception e) {
            isRecording = false;
            Log.e(TAG, "startCapture failed", e);
            promise.reject("CAPTURE_ERROR", "Failed to start capture: " + e.getMessage());
        }
    }

    @ReactMethod
    public void stopCapture(Promise promise) {
        if (!isRecording || audioRecord == null) {
            promise.resolve(null); // Not recording or not initialized
            return;
        }
        isRecording = false; // Signal the thread to stop
        try {
            if (recordingThread != null) {
                recordingThread.join(500); // Wait for thread to finish
            }
            if (audioRecord.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                 audioRecord.stop();
            }
            Log.d(TAG, "Audio recording stopped.");
            promise.resolve(null);
        } catch (Exception e) {
            Log.e(TAG, "stopCapture failed", e);
            promise.reject("CAPTURE_ERROR", "Failed to stop capture: " + e.getMessage());
        } finally {
            recordingThread = null;
        }
    }

    @ReactMethod
    public void playAudio(String pcmDataBase64, Promise promise) {
        if (audioTrack == null || audioTrack.getState() != AudioTrack.STATE_INITIALIZED) {
            promise.reject("PLAYBACK_ERROR", "AudioTrack not initialized.");
            return;
        }

        try {
            byte[] pcmData = Base64.decode(pcmDataBase64, Base64.NO_WRAP);
            if (pcmData.length > 0) {
                if (audioTrack.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) {
                    audioTrack.play(); // Start playback if not already playing
                    isPlaying = true;
                }
                audioTrack.write(pcmData, 0, pcmData.length);
            }
            promise.resolve(null);
        } catch (Exception e) {
            Log.e(TAG, "playAudio failed", e);
            promise.reject("PLAYBACK_ERROR", "Failed to play audio: " + e.getMessage());
        }
    }

    @ReactMethod
    public void cleanup(Promise promise) {
        Log.d(TAG, "Cleaning up AudioModule");
        if (isRecording) {
            stopCapture(Arguments.createPromise(
                (result) -> {}, // onSuccess: do nothing
                (code, message) -> Log.e(TAG, "Error stopping capture during cleanup: " + message) // onError
            ));
        }

        if (audioRecord != null) {
            if (audioRecord.getState() == AudioRecord.STATE_INITIALIZED) {
                 audioRecord.release();
            }
            audioRecord = null;
        }
        if (audioTrack != null) {
            if (isPlaying && audioTrack.getPlayState() == AudioTrack.PLAYSTATE_PLAYING) {
                audioTrack.stop();
            }
            if (audioTrack.getState() == AudioTrack.STATE_INITIALIZED) {
                audioTrack.release();
            }
            audioTrack = null;
            isPlaying = false;
        }
        Log.d(TAG, "Audio components released.");
        promise.resolve(null);
    }

    // Required for React Native event emitter
    @ReactMethod
    public void addListener(String eventName) {
        // Keep: Required for RN built in Event Emitter Calls.
    }

    @ReactMethod
    public void removeListeners(Integer count) {
        // Keep: Required for RN built in Event Emitter Calls.
    }
}