// EWonicBleAdvertiser.m
#import "EWonicBleAdvertiser.h"
#import <React/RCTLog.h>
#import <CoreBluetooth/CoreBluetooth.h>

@interface EWonicBleAdvertiser ()

// Internal properties
@property (nonatomic, strong) CBPeripheralManager *peripheralManager;
@property (nonatomic, strong) NSDictionary<NSString *, id> *advertisingData;
@property (nonatomic, assign) BOOL isCurrentlyAdvertising;
@property (nonatomic, strong) CBUUID *serviceUUID;

// Stored promise blocks (must be copied)
@property (nonatomic, copy) RCTPromiseResolveBlock startPromiseResolve;
@property (nonatomic, copy) RCTPromiseRejectBlock startPromiseReject;

@end

@implementation EWonicBleAdvertiser

RCT_EXPORT_MODULE(); // Uses the class name "EWonicBleAdvertiser" by default

// Initialization
- (instancetype)init {
    if (self = [super init]) {
        dispatch_queue_t mainQueue = dispatch_get_main_queue();
        NSDictionary *options = @{CBPeripheralManagerOptionShowPowerAlertKey: @YES};
        _peripheralManager = [[CBPeripheralManager alloc] initWithDelegate:self queue:mainQueue options:options];
        RCTLogInfo(@"[EWonicBleAdvertiser] PeripheralManager initialized");
        _isCurrentlyAdvertising = NO; // Initialize state
    }
    return self;
}

// --- Exported Methods ---

RCT_EXPORT_METHOD(startAdvertising:(NSString *)uuidString
                  localName:(NSString *)localName
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    RCTLogInfo(@"[EWonicBleAdvertiser] JS called startAdvertising: UUID=%@, Name=%@", uuidString, localName);

    CBUUID *uuid = [CBUUID UUIDWithString:uuidString];
    if (!uuid) {
        reject(@"E_INVALID_UUID", @"Invalid Service UUID format", nil);
        return;
    }
    self.serviceUUID = uuid; // Store for potential future use if needed

    if (self.isCurrentlyAdvertising) {
        RCTLogInfo(@"[EWonicBleAdvertiser] Already advertising");
        reject(@"E_ALREADY_ADVERTISING", @"Advertising is already active", nil);
        return;
    }

    if (self.startPromiseResolve != nil) {
        RCTLogInfo(@"[EWonicBleAdvertiser] Advertising start already pending");
        reject(@"E_PENDING_START", @"Advertising start is already pending", nil);
        return;
    }

    // Store data and promise callbacks
    NSMutableDictionary<NSString *, id> *dataToAdvertise = [NSMutableDictionary dictionary];
    dataToAdvertise[CBAdvertisementDataServiceUUIDsKey] = @[uuid];
    if (localName && ![localName isEqualToString:@""]) {
        dataToAdvertise[CBAdvertisementDataLocalNameKey] = localName;
    }

    self.advertisingData = [NSDictionary dictionaryWithDictionary:dataToAdvertise]; // Store immutable copy
    self.startPromiseResolve = resolve;   // Copy the blocks
    self.startPromiseReject = reject;     // Copy the blocks

    RCTLogInfo(@"[EWonicBleAdvertiser] Advertising data stored. Checking BT state...");

    // Check current state and try to start
    if (self.peripheralManager.state == CBManagerStatePoweredOn) {
        RCTLogInfo(@"[EWonicBleAdvertiser] Bluetooth is Powered On. Starting advertising attempt...");
        [self.peripheralManager startAdvertising:self.advertisingData];
    } else {
        RCTLogInfo(@"[EWonicBleAdvertiser] Bluetooth not Powered On (State: %ld). Waiting for state update.", (long)self.peripheralManager.state);
        // Reject immediately if state is definitively off/unauthorized etc.
         if (self.peripheralManager.state == CBManagerStatePoweredOff ||
             self.peripheralManager.state == CBManagerStateUnauthorized ||
             self.peripheralManager.state == CBManagerStateUnsupported) {
              NSString *message = [NSString stringWithFormat:@"Bluetooth not ready (State: %ld)", (long)self.peripheralManager.state];
              [self clearStartPromiseWithRejectCode:@"E_BT_STATE" message:message error:nil];
         }
         // Otherwise, peripheralManagerDidUpdateState will handle it
    }
}

RCT_EXPORT_METHOD(stopAdvertising:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    RCTLogInfo(@"[EWonicBleAdvertiser] JS called stopAdvertising");

    if (!self.isCurrentlyAdvertising && self.startPromiseResolve == nil) {
         RCTLogInfo(@"[EWonicBleAdvertiser] Not advertising and no start pending.");
         resolve(@"Already stopped"); // Nothing to stop
         return;
    }

    // Reject any pending start promise
    if (self.startPromiseReject != nil) {
         RCTLogInfo(@"[EWonicBleAdvertiser] Clearing pending start promise due to stop request.");
         [self clearStartPromiseWithRejectCode:@"E_STOPPED" message:@"Advertising stopped before starting" error:nil];
    }

    if (self.peripheralManager.isAdvertising) {
         RCTLogInfo(@"[EWonicBleAdvertiser] Calling CoreBluetooth stopAdvertising...");
         [self.peripheralManager stopAdvertising]; // Stop the actual advertising
    } else {
        RCTLogInfo(@"[EWonicBleAdvertiser] CoreBluetooth manager was not advertising (clearing state anyway).");
    }

    // Clean up internal state immediately
    [self setIsCurrentlyAdvertising:NO]; // Use setter to trigger event if needed (or direct ivar access if no side effects)
    self.advertisingData = nil;

    resolve(@"Stop advertising request processed");
}

RCT_EXPORT_METHOD(getAdvertisingState:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    resolve(@(self.isCurrentlyAdvertising)); // Wrap BOOL in NSNumber
}

RCT_EXPORT_METHOD(getBluetoothState:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    resolve([self mapManagerStateToString:self.peripheralManager.state]);
}

// --- Helper Methods ---

- (void)clearStartPromiseWithResolve:(id)result {
    if (self.startPromiseResolve) {
        RCTLogInfo(@"[EWonicBleAdvertiser] Resolving start promise: %@", result);
        self.startPromiseResolve(result);
        self.startPromiseResolve = nil;
        self.startPromiseReject = nil;
        // Keep advertisingData if resolved successfully
    }
}

- (void)clearStartPromiseWithRejectCode:(NSString *)code message:(NSString *)message error:(NSError *)error {
    if (self.startPromiseReject) {
        RCTLogInfo(@"[EWonicBleAdvertiser] Rejecting start promise: %@ - %@", code, message);
        self.startPromiseReject(code, message, error);
        self.startPromiseResolve = nil;
        self.startPromiseReject = nil;
        // Clear advertising data if start failed/stopped before success
        self.advertisingData = nil;
    }
}

- (NSString *)mapManagerStateToString:(CBManagerState)state {
    switch (state) {
        case CBManagerStatePoweredOn:   return @"PoweredOn";
        case CBManagerStatePoweredOff:  return @"PoweredOff";
        case CBManagerStateResetting:   return @"Resetting";
        case CBManagerStateUnauthorized:return @"Unauthorized";
        case CBManagerStateUnsupported: return @"Unsupported";
        case CBManagerStateUnknown:
        default:                        return @"Unknown";
    }
}

// Override isCurrentlyAdvertising setter to send event
- (void)setIsCurrentlyAdvertising:(BOOL)isCurrentlyAdvertising {
    if (_isCurrentlyAdvertising != isCurrentlyAdvertising) {
        _isCurrentlyAdvertising = isCurrentlyAdvertising;
        RCTLogInfo(@"[EWonicBleAdvertiser] Advertising state changed: %d", _isCurrentlyAdvertising);
        [self sendEventWithName:@"onAdvertisingStateChanged" body:@{@"isAdvertising": @(_isCurrentlyAdvertising)}];
    }
}

// --- CBPeripheralManagerDelegate Methods ---

- (void)peripheralManagerDidUpdateState:(CBPeripheralManager *)peripheral {
    NSString *stateString = [self mapManagerStateToString:peripheral.state];
    RCTLogInfo(@"[EWonicBleAdvertiser] peripheralManagerDidUpdateState: %@ (%ld)", stateString, (long)peripheral.state);
    [self sendEventWithName:@"onBluetoothStateChanged" body:@{@"state": stateString}];

    if (peripheral.state == CBManagerStatePoweredOn) {
        // If BT just turned on AND we have a pending request, start it now
        if (self.advertisingData && self.startPromiseResolve != nil) {
             RCTLogInfo(@"[EWonicBleAdvertiser] State became PoweredOn with pending request. Starting advertising...");
             [self.peripheralManager startAdvertising:self.advertisingData];
        }
    } else {
        // Bluetooth is not on
        [self setIsCurrentlyAdvertising:NO]; // Ensure state is updated via setter (sends event)

        // If we were waiting to start, reject the promise now
        if (self.startPromiseReject != nil) {
             NSString *message = [NSString stringWithFormat:@"Bluetooth Peripheral Manager not ready (State: %ld)", (long)peripheral.state];
             [self clearStartPromiseWithRejectCode:@"E_BT_STATE" message:message error:nil];
        }
         // If the manager was actively advertising, stopAdvertising was likely called implicitly,
         // but we ensure our internal state `isCurrentlyAdvertising` is false via the setter.
    }
}

- (void)peripheralManagerDidStartAdvertising:(CBPeripheralManager *)peripheral error:(NSError *)error {
    if (error) {
        RCTLogError(@"[EWonicBleAdvertiser] peripheralManagerDidStartAdvertising: FAILED - %@", error.localizedDescription);
        [self setIsCurrentlyAdvertising:NO];
        [self clearStartPromiseWithRejectCode:@"E_ADVERT_START_FAILED" message:error.localizedDescription error:error];
    } else {
        RCTLogInfo(@"[EWonicBleAdvertiser] peripheralManagerDidStartAdvertising: SUCCESS");
        [self setIsCurrentlyAdvertising:YES];
        [self clearStartPromiseWithResolve:@"Advertising started successfully"];
        // Keep advertisingData until stop is called? Or clear here? Let's keep it.
    }
}

// --- RCTEventEmitter Methods ---

- (NSArray<NSString *> *)supportedEvents {
    return @[@"onAdvertisingStateChanged", @"onBluetoothStateChanged"];
}

// Required for Modules that use Background Queues / Rely on Main Thread
+ (BOOL)requiresMainQueueSetup {
  // CoreBluetooth requires the main queue for delegate callbacks and state updates.
  return YES;
}

// --- Cleanup ---

- (void)dealloc {
     RCTLogInfo(@"[EWonicBleAdvertiser] Deinit: Stopping advertising if active.");
     if (self.peripheralManager != nil && self.peripheralManager.isAdvertising) {
          [self.peripheralManager stopAdvertising];
          // Optional: Set delegate to nil?
          // self.peripheralManager.delegate = nil;
     }
}

// Prevent warnings if compiled on versions of React Native that don't automatically implement this
// (though RCTEventEmitter likely handles this now)
- (void)invalidate {
    [super invalidate]; // Call super if it exists (newer RN versions)
    RCTLogInfo(@"[EWonicBleAdvertiser] invalidate called. Stopping advertising.");
     if (self.peripheralManager != nil && self.peripheralManager.isAdvertising) {
          [self.peripheralManager stopAdvertising];
     }
     // Setting delegate to nil and manager to nil might be good here too
     // self.peripheralManager.delegate = nil;
     // self.peripheralManager = nil;
}

@end
