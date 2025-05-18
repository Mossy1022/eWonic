// PCMPlayer.m
#import "PCMPlayer.h"
#import <AudioToolbox/AudioToolbox.h>

@implementation PCMPlayer {
    AudioQueueRef _audioQueue;
    AudioStreamBasicDescription _format;
    BOOL _queueStarted;
    int _sampleRate;
}

RCT_EXPORT_MODULE();

RCT_EXPORT_METHOD(setup:(NSInteger)channels sampleRate:(NSInteger)sampleRate)
{
    [self stop]; // stop any existing
    _queueStarted = NO;
    _sampleRate = (int)sampleRate;
    _format.mSampleRate = sampleRate;
    _format.mFormatID = kAudioFormatLinearPCM;
    _format.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
    _format.mFramesPerPacket = 1;
    _format.mChannelsPerFrame = channels;
    _format.mBitsPerChannel = 16;
    _format.mBytesPerPacket = 2 * channels;
    _format.mBytesPerFrame = 2 * channels;
    OSStatus status = AudioQueueNewOutput(&_format, NULL, NULL, NULL, NULL, 0, &_audioQueue);
    if (status == noErr) {
        _queueStarted = YES;
        AudioQueueStart(_audioQueue, NULL);
    }
}

RCT_EXPORT_METHOD(write:(NSString *)base64PCM)
{
    if (!_queueStarted) return;
    NSData *pcmData = [[NSData alloc] initWithBase64EncodedString:base64PCM options:0];
    if (!pcmData) return;
    AudioQueueBufferRef buffer;
    UInt32 bufferSize = (UInt32)pcmData.length;
    OSStatus status = AudioQueueAllocateBuffer(_audioQueue, bufferSize, &buffer);
    if (status == noErr) {
        memcpy(buffer->mAudioData, pcmData.bytes, bufferSize);
        buffer->mAudioDataByteSize = bufferSize;
        AudioQueueEnqueueBuffer(_audioQueue, buffer, 0, NULL);
    }
}

RCT_EXPORT_METHOD(stop)
{
    if (_queueStarted && _audioQueue) {
        AudioQueueStop(_audioQueue, true);
        AudioQueueDispose(_audioQueue, true);
        _audioQueue = NULL;
        _queueStarted = NO;
    }
}
@end