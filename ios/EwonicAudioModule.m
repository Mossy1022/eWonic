// ios/EwonicAudioModule.m
#import "EwonicAudioModule.h"
#import <React/RCTLog.h>
#import <React/RCTConvert.h>
#import <AVFoundation/AVFoundation.h>

@interface EwonicAudioModule ()
// Capture Engine
@property (nonatomic, strong) AVAudioEngine *captureEngine;
@property (nonatomic, strong) AVAudioInputNode *inputNode;

// Audio Converter
@property (nonatomic, strong) AVAudioConverter *audioConverter;
@property (nonatomic, strong) AVAudioPCMBuffer *conversionOutputBuffer;

// Playback (Using AVAudioPlayer as an initial step for testing data flow)
@property (nonatomic, strong) AVAudioPlayer *audioPlayer;
@property (nonatomic, strong) NSMutableArray *audioQueue; // Kept for potential future use
@end

@implementation EwonicAudioModule

RCT_EXPORT_MODULE(); // Exports as "EwonicAudioModule"

- (instancetype)init
{
    self = [super init];
    if (self) {
        _audioSession = [AVAudioSession sharedInstance];
        _captureEngine = [[AVAudioEngine alloc] init];
        _inputNode = [_captureEngine inputNode];
        _audioQueue = [[NSMutableArray alloc] init];
        
        _isRecording = NO;
        _isPlaying = NO;
        _sampleRate = 16000;
        _channels = 1;
        _bitDepth = 16;
        _bufferSize = 1024; // Default tap buffer size in frames (at hardware rate)
        RCTLogInfo(@"[EwonicAudioModule Native] EwonicAudioModule initialized instance: %@", self);
        // Log module name to ensure it's correct
        RCTLogInfo(@"[EwonicAudioModule Native] My moduleName as seen by [[self class] moduleName] is: %@", [[self class] moduleName]);
    }
    return self;
}

+ (BOOL)requiresMainQueueSetup
{
    // The module works with AVAudioSession which expects interaction from
    // the main thread. Initializing on the main queue prevents invalid bridge
    // references when dispatching events.
    return YES;
}

// This is crucial for RCTEventEmitter
- (NSArray<NSString *> *)supportedEvents
{
    return @[@"onAudioData"];
}

- (void)dealloc {
    RCTLogInfo(@"[EwonicAudioModule Native] Deallocating: %@", self);
    if (self.isRecording) {
        [self stopCaptureInternal];
    }
    if (_captureEngine.isRunning) {
        [_captureEngine stop];
    }
    if (_inputNode) {
        [_inputNode removeTapOnBus:0];
    }
    _audioConverter = nil;
    _conversionOutputBuffer = nil;

    if (self.audioPlayer && self.audioPlayer.isPlaying) {
        [self.audioPlayer stop];
    }
    self.audioPlayer = nil;
}

- (BOOL)ensureAudioSessionActive:(NSError **)error {
    AVAudioSession *session = [AVAudioSession sharedInstance];
    AVAudioSessionCategory desiredCategory = AVAudioSessionCategoryPlayAndRecord;
    AVAudioSessionMode desiredMode = AVAudioSessionModeVoiceChat;
    AVAudioSessionCategoryOptions desiredOptions = AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionAllowAirPlay;

    BOOL needsUpdate = NO;
    if (![session.category isEqualToString:desiredCategory] || ![session.mode isEqualToString:desiredMode]) {
        needsUpdate = YES;
    }
    
    if (needsUpdate) {
        RCTLogInfo(@"[EwonicAudioModule Native] Updating audio session. Current: %@/%@ -> %@/%@", session.category, session.mode, desiredCategory, desiredMode);
        if (![session setCategory:desiredCategory mode:desiredMode options:desiredOptions error:error]) {
            RCTLogError(@"[EwonicAudioModule Native] Failed to set audio session category/mode: %@", (*error).localizedDescription);
            return NO;
        }
    }

    NSError *activationError = nil;
    // setActive:error: can be called even if already active.
    // It might return an error if it's already active with the same properties, or if there's a conflict.
    [session setActive:YES error:&activationError];
    if (activationError) {
        // Code 561017449 (kAudioSessionAlreadyActiveError on older SDKs) or AVAudioSessionErrorCodeCannotStartPlaying often mean it's already active.
        if (activationError.code == AVAudioSessionErrorCodeCannotStartPlaying || activationError.code == 561017449) {
            RCTLogInfo(@"[EwonicAudioModule Native] Audio session setActive:YES reported: %@ (Code: %ld). This often means it was already active or no change was needed.", activationError.localizedDescription, (long)activationError.code);
            if (error && *error == nil) { /* Don't overwrite a prior error */ }
            else if (error) { *error = nil; } // Clear this specific "error" as it's often not fatal.
        } else {
            RCTLogWarn(@"[EwonicAudioModule Native] Failed to activate audio session with a more critical error: %@", activationError.localizedDescription);
            if (error && *error == nil) *error = activationError;
            else if (!error) *error = activationError; // Store if error pointer was nil
            return NO; // A more serious activation error
        }
    } else {
        RCTLogInfo(@"[EwonicAudioModule Native] Audio session activated successfully by this module (or was already active without error).");
    }
    return YES;
}

RCT_EXPORT_METHOD(initialize:(NSInteger)sampleRate
                  bufferSize:(NSInteger)jsBufferSize
                  channels:(NSInteger)channels
                  bitDepth:(NSInteger)bitDepth
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    RCTLogInfo(@"[EwonicAudioModule Native] Initializing: Target SR=%ld, Tap BufSize=%ld frames, Target Ch=%ld, Target Depth=%ld",
               (long)sampleRate, (long)jsBufferSize, (long)channels, (long)bitDepth);
    
    self.sampleRate = sampleRate;
    self.channels = channels;
    self.bitDepth = bitDepth;
    self.bufferSize = jsBufferSize;

    if (self.bitDepth != 16) { reject(@"INIT_ERROR_PARAMS", @"Output bitDepth must be 16.", nil); return; }
    if (self.channels != 1) { reject(@"INIT_ERROR_PARAMS", @"Output channels must be 1 (mono).", nil); return; }

    NSError *error = nil;
    if (![self ensureAudioSessionActive:&error]) {
        reject(@"INIT_ERROR_SESSION", [NSString stringWithFormat:@"Failed to ensure audio session is active: %@", error ? error.localizedDescription : @"Unknown session error"], error);
        return;
    }

    AVAudioFormat *hardwareFormat = [self.inputNode outputFormatForBus:0];
    if (hardwareFormat.sampleRate == 0 || hardwareFormat.channelCount == 0) {
        RCTLogError(@"[EwonicAudioModule Native] Failed to get valid hardware input format. SR: %f, CH: %u", hardwareFormat.sampleRate, hardwareFormat.channelCount);
        reject(@"INIT_ERROR_HARDWARE_FORMAT", @"Failed to get valid hardware audio input format.", nil); return;
    }
    RCTLogInfo(@"[EwonicAudioModule Native] Hardware input format: %@", hardwareFormat);

    AVAudioFormat *outputPCMFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16
                                                                     sampleRate:(double)self.sampleRate
                                                                       channels:(AVAudioChannelCount)self.channels
                                                                    interleaved:(hardwareFormat.isInterleaved)];
    if (!outputPCMFormat) { reject(@"INIT_ERROR_OUTPUT_FORMAT", @"Failed to create target output AVAudioFormat (Int16).", nil); return; }
    RCTLogInfo(@"[EwonicAudioModule Native] Desired output format for JS: %@", outputPCMFormat);

    self.audioConverter = [[AVAudioConverter alloc] initFromFormat:hardwareFormat toFormat:outputPCMFormat];
    if (!self.audioConverter) {
        RCTLogError(@"[EwonicAudioModule Native] Failed to create AVAudioConverter from %@ to %@", hardwareFormat, outputPCMFormat);
        reject(@"INIT_ERROR_CONVERTER", @"Failed to create AVAudioConverter.", nil); return;
    }

    double sampleRateRatio = outputPCMFormat.sampleRate / hardwareFormat.sampleRate;
    AVAudioFrameCount outputFrameCapacity = (AVAudioFrameCount)ceil(self.bufferSize * sampleRateRatio);
    if (outputFrameCapacity == 0) outputFrameCapacity = (AVAudioFrameCount)ceil(1024 * sampleRateRatio); // Ensure non-zero
    self.conversionOutputBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:outputPCMFormat frameCapacity:outputFrameCapacity];
    if (!self.conversionOutputBuffer) { reject(@"INIT_ERROR_CONVERSION_BUFFER", @"Failed to create conversion output buffer.", nil); return; }
    RCTLogInfo(@"[EwonicAudioModule Native] Conversion output buffer capacity: %u frames (for tap input of %ld frames)", outputFrameCapacity, (long)self.bufferSize);

    if (self.inputNode) {
      [self.inputNode removeTapOnBus:0];
      RCTLogInfo(@"[EwonicAudioModule Native] Cleared existing tap on input bus 0.");
    }
    
    __weak EwonicAudioModule *weakSelf = self; // Capture self weakly for the block
    [self.inputNode installTapOnBus:0
                       bufferSize:(AVAudioFrameCount)self.bufferSize
                             format:hardwareFormat
                              block:^(AVAudioPCMBuffer * _Nonnull pcmBufferFromTap, AVAudioTime * _Nonnull when) {
        EwonicAudioModule *strongSelf = weakSelf; // Create strong ref inside block
        if (!strongSelf || !strongSelf.isRecording || !strongSelf.audioConverter || !strongSelf.conversionOutputBuffer) {
            return;
        }
        if (pcmBufferFromTap.frameLength == 0) return;
        
        strongSelf.conversionOutputBuffer.frameLength = strongSelf.conversionOutputBuffer.frameCapacity;
        NSError *conversionError = nil;
        __block BOOL inputBlockCalledOnce = NO;
        AVAudioConverterInputBlock inputBlock = ^AVAudioPCMBuffer * _Nullable(AVAudioPacketCount frameCount, AVAudioConverterInputStatus * _Nonnull outStatus) {
            if (inputBlockCalledOnce) { *outStatus = AVAudioConverterInputStatus_NoDataNow; return nil; }
            *outStatus = AVAudioConverterInputStatus_HaveData; inputBlockCalledOnce = YES;
            return pcmBufferFromTap;
        };
        
        AVAudioConverterOutputStatus status = [strongSelf.audioConverter convertToBuffer:strongSelf.conversionOutputBuffer
                                                                error:&conversionError
                                                           withInputFromBlock:inputBlock];
        
        // RCTLogInfo(@"[TAP DEBUG] Conversion Status: %ld. Output Buffer FrameLength: %u", (long)status, strongSelf.conversionOutputBuffer.frameLength);

        if (status == AVAudioConverterOutputStatus_Error) {
            RCTLogWarn(@"[EwonicAudioModule Native Tap] Audio conversion error: %@", conversionError ? conversionError.localizedDescription : @"Unknown");
            return;
        }
        
        if (status == AVAudioConverterOutputStatus_HaveData && strongSelf.conversionOutputBuffer.frameLength > 0) {
            if (strongSelf.conversionOutputBuffer.format.commonFormat == AVAudioPCMFormatInt16 &&
                strongSelf.conversionOutputBuffer.int16ChannelData && strongSelf.conversionOutputBuffer.int16ChannelData[0]) {
                NSUInteger lengthInBytes = strongSelf.conversionOutputBuffer.frameLength * strongSelf.channels * sizeof(SInt16);
                NSData *dataToSend = [NSData dataWithBytes:strongSelf.conversionOutputBuffer.int16ChannelData[0] length:lengthInBytes];
                if (dataToSend && dataToSend.length > 0) {
                    NSString *base64Data = [dataToSend base64EncodedStringWithOptions:0];
                    
                    dispatch_async(dispatch_get_main_queue(), ^{
                        EwonicAudioModule *mainQStrongSelf = weakSelf; // Re-strongify for this specific dispatch block
                        if (!mainQStrongSelf || !mainQStrongSelf.isRecording) { // Check isRecording again on mainQ
                            if(!mainQStrongSelf) RCTLogWarn(@"[TAP MAINQ DEBUG] Event NOT sent: self (module instance) was deallocated before mainQ block.");
                            else RCTLogInfo(@"[TAP MAINQ DEBUG] Event NOT sent: mainQStrongSelf.isRecording became NO.");
                            return;
                        }

                        if (!mainQStrongSelf.bridge) {
                            RCTLogWarn(@"[TAP MAINQ DEBUG] Event NOT sent: mainQStrongSelf.bridge is NIL.");
                            return;
                        }

                        if (base64Data) {
                            // RCTLogInfo(@"[EwonicAudioModule Native Tap] SENDING onAudioData event (on main queue). Frames: %u, Base64Len: %lu", mainQStrongSelf.conversionOutputBuffer.frameLength, (unsigned long)base64Data.length);
                            [mainQStrongSelf sendEventWithName:@"onAudioData" body:@{@"data": base64Data}];
                        } else {
                             RCTLogWarn(@"[TAP MAINQ DEBUG] Event NOT sent: base64Data is nil/empty after all bridge checks (using mainQStrongSelf).");
                        }
                    });
                } else {
                     RCTLogWarn(@"[TAP DEBUG] dataToSend is nil or empty after NSData creation.");
                }
            } else {
                 RCTLogWarn(@"[EwonicAudioModule Native Tap] Conversion buffer format problem AFTER HaveData. Expected Int16. Got: %@, Chan0 Valid: %s",
                            strongSelf.conversionOutputBuffer.format, (strongSelf.conversionOutputBuffer.int16ChannelData && strongSelf.conversionOutputBuffer.int16ChannelData[0]) ? "YES" : "NO");
            }
        } else if (status == AVAudioConverterOutputStatus_InputRanDry) {
             // RCTLogInfo(@"[TAP DEBUG] Converter status: InputRanDry.");
        } else if (status == AVAudioConverterOutputStatus_EndOfStream) {
            RCTLogInfo(@"[TAP DEBUG] Converter status: EndOfStream.");
        }
    }];
    RCTLogInfo(@"[EwonicAudioModule Native] Tap installed on input node.");

    @try {
        // AVAudioEngine does not expose an `isPrepared` property. Calling
        // `prepare` multiple times is safe and ensures the engine has
        // allocated the resources it needs before starting.
        [self.captureEngine prepare];
        RCTLogInfo(@"[EwonicAudioModule Native] Capture engine prepared.");
    } @catch (NSException *exception) {
        RCTLogError(@"[EwonicAudioModule Native] Exception preparing engine: %@. %@", exception.name, exception.reason);
        reject(@"INIT_ERROR_ENGINE_PREPARE", [NSString stringWithFormat:@"Exception preparing engine: %@",exception.reason], nil);
        return;
    }
    resolve(nil);
}

RCT_EXPORT_METHOD(startCapture:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    RCTLogInfo(@"[EwonicAudioModule Native] startCapture called by JS.");
    if (!self.captureEngine) { reject(@"CAPTURE_ERROR_NO_ENGINE", @"CaptureEngine not initialized.", nil); return; }
    if (self.isRecording && self.captureEngine.isRunning) {
        RCTLogInfo(@"[EwonicAudioModule Native] Already recording and engine running.");
        resolve(nil); return;
    }

    NSError *error = nil;
    if (![self ensureAudioSessionActive:&error]) {
        reject(@"CAPTURE_ERROR_SESSION", [NSString stringWithFormat:@"Failed to ensure audio session for capture: %@", error ? error.localizedDescription : @"Unknown"], error);
        return;
    }
    
    if (!self.captureEngine.isRunning) {
        @try {
            [self.captureEngine startAndReturnError:&error];
            if (error) {
                RCTLogError(@"[EwonicAudioModule Native] Failed to start capture engine: %@", error.localizedDescription);
                reject(@"CAPTURE_ERROR_ENGINE_START", [NSString stringWithFormat:@"Failed to start capture engine: %@", error.localizedDescription], error);
                return;
            }
            RCTLogInfo(@"[EwonicAudioModule Native] After engine start attempt, isRunning: %d", self.captureEngine.isRunning);
        } @catch (NSException *exception) {
            RCTLogError(@"[EwonicAudioModule Native] Exception starting engine: %@. %@", exception.name, exception.reason);
            reject(@"CAPTURE_ERROR_ENGINE_EXCEPTION", [NSString stringWithFormat:@"Exception starting engine: %@",exception.reason], nil);
            return;
        }
    }
    
    self.isRecording = YES;
    RCTLogInfo(@"[EwonicAudioModule Native] Audio capture started (Engine isRunning now confirmed as: %d).", self.captureEngine.isRunning);
    resolve(nil);
}

- (void)stopCaptureInternal {
    if (!self.isRecording && !self.captureEngine.isRunning) return;
    RCTLogInfo(@"[EwonicAudioModule Native] Stopping capture internally (wasRecording: %d, engineWasRunning: %d)...", self.isRecording, self.captureEngine.isRunning);
    self.isRecording = NO;
    if (self.captureEngine.isRunning) {
        [self.captureEngine pause];
        RCTLogInfo(@"[EwonicAudioModule Native] Capture engine paused.");
    }
}

RCT_EXPORT_METHOD(stopCapture:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    RCTLogInfo(@"[EwonicAudioModule Native] stopCapture called by JS.");
    [self stopCaptureInternal];
    resolve(nil);
}

RCT_EXPORT_METHOD(playAudio:(NSString *)pcmDataBase64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    RCTLogInfo(@"[EwonicAudioModule Native] playAudio called (base64 data length: %lu)", (unsigned long)pcmDataBase64.length);
    if (!pcmDataBase64 || [pcmDataBase64 length] == 0) {
        reject(@"PLAYBACK_ERROR_EMPTY_DATA", @"PCM data is empty", nil); return;
    }
    NSData *pcmData = [[NSData alloc] initWithBase64EncodedString:pcmDataBase64 options:0];
    if (!pcmData || pcmData.length == 0) {
        reject(@"PLAYBACK_ERROR_DECODE", @"Failed to decode Base64 PCM data or data is empty.", nil); return;
    }
    RCTLogInfo(@"[EwonicAudioModule Native] Decoded PCM data for playback, length: %lu bytes", (unsigned long)pcmData.length);

    NSError *sessionError = nil;
    if (![self ensureAudioSessionActive:&sessionError]) {
        reject(@"PLAYBACK_ERROR_SESSION", [NSString stringWithFormat:@"Failed to ensure audio session for playback: %@", sessionError ? sessionError.localizedDescription : @"Unknown"], sessionError);
        return;
    }
    
    RCTLogWarn(@"[EwonicAudioModule Native] playAudio using AVAudioPlayer is a placeholder for PCM streaming. Refactor to AVAudioEngine for better performance.");

    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.audioPlayer && self.audioPlayer.isPlaying) {
            [self.audioPlayer stop];
             RCTLogInfo(@"[EwonicAudioModule Native] Stopped previous AVAudioPlayer instance.");
        }
        
        NSError *playerError = nil;
        self.audioPlayer = [[AVAudioPlayer alloc] initWithData:pcmData error:&playerError];
        if (playerError || !self.audioPlayer) {
            RCTLogError(@"[EwonicAudioModule Native] Failed to initialize AVAudioPlayer: %@", playerError.localizedDescription);
            self.audioPlayer = nil;
            reject(@"PLAYBACK_ERROR_INIT", [NSString stringWithFormat:@"Failed to init AVAudioPlayer: %@", playerError.localizedDescription], playerError);
            return;
        }
        self.audioPlayer.delegate = self;
        self.audioPlayer.volume = 1.0;

        if ([self.audioPlayer prepareToPlay]) {
            if([self.audioPlayer play]) {
                self.isPlaying = YES;
                RCTLogInfo(@"[EwonicAudioModule Native] AVAudioPlayer started playing chunk successfully.");
                resolve(nil);
            } else {
                RCTLogError(@"[EwonicAudioModule Native] AVAudioPlayer -play command returned NO.");
                reject(@"PLAYBACK_ERROR_PLAY_CMD", @"AVAudioPlayer -play command failed.", nil);
            }
        } else {
            RCTLogError(@"[EwonicAudioModule Native] AVAudioPlayer failed to -prepareToPlay.");
            reject(@"PLAYBACK_ERROR_PREPARE", @"AVAudioPlayer failed to -prepareToPlay.", nil);
        }
    });
}

RCT_EXPORT_METHOD(cleanup:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    RCTLogInfo(@"[EwonicAudioModule Native] Cleanup module requested by JS...");
    [self stopCaptureInternal];

    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.audioPlayer && self.audioPlayer.isPlaying) {
            [self.audioPlayer stop];
        }
        self.audioPlayer = nil;
        self.isPlaying = NO;
    });
    
    if (self.inputNode) {
        [self.inputNode removeTapOnBus:0];
        RCTLogInfo(@"[EwonicAudioModule Native] Tap removed from input node during cleanup.");
    }
    if (self.captureEngine.isRunning) {
         [self.captureEngine stop];
         RCTLogInfo(@"[EwonicAudioModule Native] Capture engine stopped during cleanup.");
    }
    
    _audioConverter = nil;
    _conversionOutputBuffer = nil;
    
    RCTLogInfo(@"[EwonicAudioModule Native] Cleanup method finished.");
    resolve(nil);
}

// Called when the React Native bridge is about to be invalidated
- (void)invalidate
{
    RCTLogInfo(@"[EwonicAudioModule Native] Bridge invalidating. Stopping capture and cleaning resources.");
    [self stopCaptureInternal];
    if (self.inputNode) {
        [self.inputNode removeTapOnBus:0];
    }
    if (self.captureEngine.isRunning) {
        [self.captureEngine stop];
    }
    _audioConverter = nil;
    _conversionOutputBuffer = nil;
}

// --- AVAudioPlayerDelegate Methods ---
- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag {
    RCTLogInfo(@"[EwonicAudioModule Native] AVAudioPlayer finished playing (success: %d)", flag);
    self.isPlaying = NO;
}

- (void)audioPlayerDecodeErrorDidOccur:(AVAudioPlayer *)player error:(NSError * __nullable)error {
    RCTLogError(@"[EwonicAudioModule Native] AVAudioPlayer decode error: %@", error.localizedDescription);
    self.isPlaying = NO;
}

@end