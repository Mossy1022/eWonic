// ios/EwonicAudioModule.h
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <AVFoundation/AVFoundation.h>

@interface EwonicAudioModule : RCTEventEmitter <RCTBridgeModule, /* AVAudioRecorderDelegate, */ AVAudioPlayerDelegate> // AVAudioRecorderDelegate might not be needed with AVAudioEngine

// Publicly accessible properties (if any are needed, keep them minimal)
// These are the ones initialized in `init` and used across methods, so they are okay here if they need to be.
// However, consider if even these could be moved to the class extension if they don't need to be
// accessed from outside EwonicAudioModule.m directly (which they typically don't for native modules).
// For now, keeping them as they were for minimal changes, but ideally, many of these could also be private.
@property (nonatomic, strong) AVAudioSession *audioSession; // Often managed internally
// @property (nonatomic, strong) AVAudioRecorder *audioRecorder; // No longer the primary capture mechanism

// State flags are fine here if other methods in the class need to check them,
// but their setters should be managed carefully.
@property (nonatomic, assign) BOOL isRecording;
@property (nonatomic, assign) BOOL isPlaying;

// Configuration properties set by initialize - these are okay to be publicly readable if needed,
// but are primarily set by the module itself.
@property (nonatomic, assign) NSInteger sampleRate;
@property (nonatomic, assign) NSInteger channels;
@property (nonatomic, assign) NSInteger bitDepth;
@property (nonatomic, assign) NSInteger bufferSize; // In frames

// Note: AVAudioEngine, inputNode, mixerNode, audioPlayer, audioQueue are now internal to the .m file

@end
