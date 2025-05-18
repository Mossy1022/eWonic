// src/services/ble/ble_discovery.ts
import {
  BleManager, Device, State, BleError, Subscription,
  Service, Characteristic, BleErrorCode // Import necessary types
} from 'react-native-ble-plx';
import { PermissionsAndroid, Platform } from 'react-native';
import { Buffer } from 'buffer'; // For Base64 encoding/decoding of signaling messages

// Import config
import {
  EWONIC_BLE_PREFIX,
  EWONIC_SIGNALING_SERVICE_UUID, // Use this for scanning
  EWONIC_SIGNALING_CHARACTERISTIC_UUID, // Needed for GATT operations later
  // EWONIC_MULTIPEER_SERVICE_TYPE, // Keep for reference? Unused now.
} from '../../config/ble_config';
import { getLocalPeerId } from '../p2p/connection_manager'; // To filter out self

// Initialize BleManager
const ble_manager = new BleManager({
restoreStateIdentifier: 'eWonicBleRestoreIdentifier',
restoreStateFunction: (restoredState) => {
  // Handle restoration if needed
  console.log('BLE Manager: Restored state', restoredState);
},
});

let stateSubscription: Subscription | null = null;
let scanSubscription: Subscription | null = null; // Store the scan subscription
let isScanning = false;

// Extended device info type - RENAME p2pIdentifier to targetPeerId
export interface DiscoveredDeviceInfo extends Device {
targetPeerId?: string | null; // The unique WebRTC peer ID parsed from advertisement
isConnectable: boolean; // Flag if it's a recognized eWonic device with a Peer ID
}

let deviceFoundCallback: ((deviceInfo: DiscoveredDeviceInfo) => void) | null = null;

// --- State Management and Permissions (keep existing functions: onStateChange, requestBluetoothPermissions) ---
const onStateChange = (newState: State) => {
console.log('BLE State Changed:', newState);
 if (newState === State.PoweredOn) {
    console.log('BLE Powered On');
    // If scanning was requested while powered off, start now
    if (deviceFoundCallback && !isScanning) {
      scanDevices();
    }
  } else {
      console.warn(`BLE not powered on (State: ${newState}). Stopping scan if active.`);
      stop_ble_discovery(); // Stop scanning if Bluetooth is not on
      // Optionally clear discovered devices list?
  }
};

const requestBluetoothPermissions = async (): Promise<boolean> => {
  // ... (permission logic remains the same)
    if (Platform.OS === 'android') {
  const apiLevel = parseInt(Platform.Version.toString(), 10);
  let permissionsToRequest: Array<any> = [];

  if (apiLevel >= 31) { // Android 12+
    permissionsToRequest = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      // ACCESS_FINE_LOCATION might not be strictly needed for scanning ONLY on API 31+
      // but often still required by libraries or for specific scan modes. Safer to include.
       PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ];
  } else { // Android 6-11
    permissionsToRequest = [
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, // Required for BLE scanning
    ];
  }

  console.log('Requesting Android BLE permissions:', permissionsToRequest);
  const granted = await PermissionsAndroid.requestMultiple(permissionsToRequest) as any;

  const allGranted = permissionsToRequest.every(
    (permission) => granted[permission] === PermissionsAndroid.RESULTS.GRANTED
  );

  if (allGranted) {
    console.log('Android BLE permissions granted.');
    return true;
  } else {
    console.error('Android BLE permissions denied.', granted);
    // Find which permission was denied
     permissionsToRequest.forEach(p => {
         if (granted[p] !== PermissionsAndroid.RESULTS.GRANTED) {
             console.error(`Permission Denied: ${p}`);
         }
     });
    return false;
  }
}
// iOS permissions are handled via Info.plist
return true;
};


/**
* Internal function to start the actual scan process.
*/
const scanDevices = () => {
if (isScanning) {
  console.log('[Discovery] Already scanning...');
  return;
}

const serviceUUIDsToScan = [EWONIC_SIGNALING_SERVICE_UUID]; // Scan specifically for our service
console.log(`[Discovery] Starting BLE scan for service UUID: ${serviceUUIDsToScan[0]}`);

ble_manager.startDeviceScan(
  serviceUUIDsToScan, // Scan for our specific service UUID
  // { allowDuplicates: true, scanMode: ScanMode.LowLatency } // Options for more frequent updates if needed
  null, // Use default scan options for now (usually balanced power/latency)
  (error, device) => {
    if (error) {
      console.error('[Discovery] BLE scan error:', error.message, `(Code: ${error.errorCode})`);
      // Handle specific errors
      if (error.errorCode === BleErrorCode.BluetoothPoweredOff || error.errorCode === BleErrorCode.BluetoothUnauthorized) {
           console.error("[Discovery] Scan failed due to Bluetooth state or permissions. Stopping scan.");
           stop_ble_discovery(); // Stop explicitly on these errors
      } else if (error.errorCode === BleErrorCode.ScanStartFailed && Platform.OS === 'android') {
          console.error("[Discovery] Android scan start failed. Location services might be off or permissions missing.");
          stop_ble_discovery();
      }
      // Other errors might be transient, decide whether to stop or continue
      return;
    }

    // Device found
    if (device && deviceFoundCallback) {
      let parsedPeerId: string | null = null;
      let isConnectable = false;
      const localId = getLocalPeerId(); // Get our own ID to filter self


      // --- Parse Local Name for Peer ID ---
      // Note: Name might be truncated, especially on iOS.
      if (device.localName && device.localName.startsWith(EWONIC_BLE_PREFIX)) {
          const potentialId = device.localName.substring(EWONIC_BLE_PREFIX.length);
          if (potentialId && potentialId !== localId) { // Check if ID exists and is not self
               parsedPeerId = potentialId;
               isConnectable = true; // Found a potential eWonic peer
               // console.log(`[Discovery] Found potential peer by name: ${device.id}, PeerID: ${parsedPeerId}`); // Noisy
          } else if (potentialId === localId) {
               // console.log(`[Discovery] Ignored own device advertisement: ${device.id}`); // Noisy
          } else {
               // console.log(`[Discovery] Found eWonic prefix but invalid/missing PeerID in name: ${device.localName}`);
          }
      } else {
         // console.log(`[Discovery] Ignored device (no matching name prefix): ${device.name || device.id} (Name: ${device.localName})`); // Noisy
      }

      // --- TODO: Alternative - Parse Manufacturer Data for Peer ID ---
      // if (device.manufacturerData && !parsedPeerId) {
      //   const decodedData = Buffer.from(device.manufacturerData, 'base64').toString('utf8'); // Assuming UTF8 encoded ID
      //   // Check if decodedData matches expected format/prefix and isn't self
      // }


      // Prepare the extended info object
      const enhancedDevice = device as DiscoveredDeviceInfo;
      enhancedDevice.targetPeerId = parsedPeerId;
      enhancedDevice.isConnectable = isConnectable;

      // Only callback if it's a connectable eWonic device (and not self)
      if (enhancedDevice.isConnectable) {
          // Pass the enhanced object, which still retains all original Device methods
          deviceFoundCallback(enhancedDevice);
      }
    }
  }
);
isScanning = true;
console.log('[Discovery] BLE Scan Started.');
};

/**
* Starts scanning for nearby BLE devices after checking state and permissions.
* @param on_device_found Callback invoked with each discovered eWonic device info.
*/
export const start_ble_discovery = async (
on_device_found: (deviceInfo: DiscoveredDeviceInfo) => void
): Promise<void> => {
console.log('[Discovery] Attempting to start BLE discovery...');
deviceFoundCallback = on_device_found; // Store the callback

// Subscribe to state changes if not already subscribed
if (!stateSubscription) {
  stateSubscription = ble_manager.onStateChange(onStateChange, true); // true to emit current state immediately
  console.log('[Discovery] Subscribed to BLE state changes.');
}

 // Check permissions first
 const permissionsGranted = await requestBluetoothPermissions();
 if (!permissionsGranted) {
     console.error('[Discovery] Stopping discovery attempt: Permissions denied.');
     deviceFoundCallback = null; // Clear callback
     stop_ble_discovery(); // Ensure scan is stopped
     throw new Error("Bluetooth permissions not granted."); // Throw error to notify UI
 }

 // Check current state
 const currentState = await ble_manager.state();
  if (currentState === State.PoweredOn) {
    scanDevices(); // Start scan immediately if powered on
  } else {
    console.log(`[Discovery] Waiting for BLE state to be PoweredOn. Current state: ${currentState}`);
    // Scan will start automatically via onStateChange when powered on
    // Ensure any previous scan is stopped if state is not PoweredOn
    if (isScanning) {
        stop_ble_discovery();
    }
  }
};

/**
* Stops scanning for nearby BLE devices.
*/
export const stop_ble_discovery = (): void => {
if (isScanning) {
  ble_manager.stopDeviceScan(); // Use the manager's method
  isScanning = false;
  console.log('[Discovery] BLE Scan Stopped.');
} else {
  // console.log('[Discovery] Scan already stopped or not started.');
}
// Clear the callback when stopping? Or keep it for restarts? Let's keep it for now.
// deviceFoundCallback = null;
};

// --- GATT Helper Functions (NEW) ---

/**
* Connects to a device and discovers the signaling service/characteristic.
* Returns the discovered characteristic object.
* *** ADD export KEYWORD ***
*/
export async function connectAndDiscoverSignaling(deviceId: string): Promise<Characteristic> {
  console.log(`[Discovery GATT] Connecting to ${deviceId}...`);
  const device = await ble_manager.connectToDevice(deviceId);
  console.log(`[Discovery GATT] Connected to ${deviceId}. Discovering services...`);
  await device.discoverAllServicesAndCharacteristics();
  console.log(`[Discovery GATT] Discovering services for ${EWONIC_SIGNALING_SERVICE_UUID}...`);
  const services = await device.services();
  const service = services.find(s => s.uuid === EWONIC_SIGNALING_SERVICE_UUID);
  if (!service) {
      await ble_manager.cancelDeviceConnection(deviceId).catch(e => console.log(`Error cancelling connection after service not found: ${e}`)); // Disconnect on failure
      throw new Error(`Signaling service ${EWONIC_SIGNALING_SERVICE_UUID} not found on device ${deviceId}`);
  }
  console.log(`[Discovery GATT] Found service. Discovering characteristic ${EWONIC_SIGNALING_CHARACTERISTIC_UUID}...`);
  const characteristics = await service.characteristics();
  const characteristic = characteristics.find(c => c.uuid === EWONIC_SIGNALING_CHARACTERISTIC_UUID);
  if (!characteristic) {
      await ble_manager.cancelDeviceConnection(deviceId).catch(e => console.log(`Error cancelling connection after char not found: ${e}`)); // Disconnect on failure
      throw new Error(`Signaling characteristic ${EWONIC_SIGNALING_CHARACTERISTIC_UUID} not found in service ${service.uuid}`);
  }
  console.log(`[Discovery GATT] Found signaling characteristic.`);
  return characteristic;
}

/**
* Writes a signaling message to the characteristic.
* Assumes message is already stringified JSON. Encodes to Base64.
*/
export async function writeSignalingMessage(characteristic: Characteristic, message: string): Promise<void> {
  const base64Message = Buffer.from(message).toString('base64');
  // console.log(`[Discovery GATT] Writing message (Base64): ${base64Message.substring(0, 100)}...`); // Noisy
  await characteristic.writeWithResponse(base64Message); // Use writeWithResponse for confirmation
  // console.log(`[Discovery GATT] Message written successfully.`); // Noisy
}

/**
* Subscribes to notifications from the signaling characteristic.
* Decodes Base64 message and calls the callback with parsed JSON.
*/
export function subscribeToSignalingMessages(
  characteristic: Characteristic,
  onMessage: (message: any) => void
): Subscription {
  console.log(`[Discovery GATT] Subscribing to notifications for characteristic ${characteristic.uuid}`);
  const subscription = characteristic.monitor((error, notifiedCharacteristic) => {
      if (error) {
          console.error(`[Discovery GATT] Signaling notification error: ${error.message} (Code: ${error.errorCode})`);
          // Handle disconnect or other errors
          if (error.errorCode === BleErrorCode.DeviceDisconnected) {
              console.warn(`[Discovery GATT] Device disconnected while monitoring signaling.`);
              // Trigger disconnection logic in LobbyScreen
          }
          // Optionally unsubscribe or attempt recovery
          return;
      }

      if (notifiedCharacteristic?.value) {
          try {
              const base64Message = notifiedCharacteristic.value;
              const jsonMessage = Buffer.from(base64Message, 'base64').toString('utf8');
              // console.log(`[Discovery GATT] Received notification (JSON): ${jsonMessage.substring(0, 100)}...`); // Noisy
              const parsedMessage = JSON.parse(jsonMessage);
              onMessage(parsedMessage); // Call the handler with the parsed object
          } catch (e) {
              console.error("[Discovery GATT] Failed to decode/parse signaling message:", e);
               console.error("[Discovery GATT] Raw Base64 received:", notifiedCharacteristic.value);
          }
      }
  });
  console.log(`[Discovery GATT] Subscription setup complete.`);
  return subscription; // Return the subscription object so it can be removed later
}

/**
* Disconnects from a device.
*/
export async function disconnectDevice(deviceId: string): Promise<void> {
  console.log(`[Discovery GATT] Disconnecting from ${deviceId}...`);
  try {
      const connected = await ble_manager.isDeviceConnected(deviceId);
      if (connected) {
          await ble_manager.cancelDeviceConnection(deviceId);
          console.log(`[Discovery GATT] Disconnected from ${deviceId}.`);
      } else {
           console.log(`[Discovery GATT] Device ${deviceId} was already disconnected.`);
      }
  } catch (error: any) {
       console.error(`[Discovery GATT] Error disconnecting from ${deviceId}: ${error.message}`);
       // Don't re-throw, just log during disconnect
  }
}


// Optional: Cleanup function
export const destroyBleManager = () => {
  console.log('[Discovery] Destroying BLE Manager...');
  stop_ble_discovery();
  if (stateSubscription) {
    stateSubscription.remove();
    stateSubscription = null;
  }
  ble_manager.destroy();
  console.log('[Discovery] BLE Manager Destroyed.');
}