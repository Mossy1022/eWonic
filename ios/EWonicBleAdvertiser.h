// EWonicBleAdvertiser.h
#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface EWonicBleAdvertiser : RCTEventEmitter <RCTBridgeModule, CBPeripheralManagerDelegate>

// No need to declare exported methods here, RCT_EXPORT_METHOD handles it.

@end
