import { Platform, NativeModules, NativeEventEmitter, EmitterSubscription } from 'react-native';
import { getLocalPeerId, initializeManager as initConnectionManager } from '../p2p/connection_manager'; // Get local Peer ID

// Import shared constants
import {
    EWONIC_BLE_PREFIX,
    EWONIC_SIGNALING_SERVICE_UUID, // Use the main service UUID for advertising
} from '../../config/ble_config';

// --- Native Module (iOS Custom Advertiser) ---
const { EWonicBleAdvertiser } = NativeModules;
const isIosAdvertiserAvailable = Platform.OS === 'ios' && EWonicBleAdvertiser;

if (Platform.OS === 'ios' && !isIosAdvertiserAvailable) {
  console.error("CRITICAL: Native module 'EWonicBleAdvertiser' not found for iOS. Check native build and linking.");
}

// --- Event Emitter (iOS Custom Advertiser) ---
const bleAdvertiserEmitter = isIosAdvertiserAvailable ? new NativeEventEmitter(EWonicBleAdvertiser) : null;
let advertisingStateListener: EmitterSubscription | null = null;
let bluetoothStateListener: EmitterSubscription | null = null;

// --- Android Advertising (Placeholder - Requires a separate library/module) ---
// Example using a hypothetical 'react-native-ble-advertiser' library
// import BleAdvertiser from 'react-native-ble-advertiser'; // Uncomment if using this library

/**
 * Starts BLE advertising. Includes the local Peer ID in the advertised name or service data.
 * Ensures Connection Manager is initialized first to get the Peer ID.
 * @throws {Error} If Peer ID cannot be obtained or advertising fails critically.
 */
export async function start_ble_advertising(): Promise<void> {
    console.log('[Advertise] Attempting to start BLE Advertising...');

    // 1. Ensure Connection Manager is initialized and get Local Peer ID
    let localPeerId: string | null;
    try {
        localPeerId = await initConnectionManager(); // Ensures CM is ready
        if (!localPeerId) {
            throw new Error("Local Peer ID is null after Connection Manager initialization.");
        }
         console.log(`[Advertise] Obtained Local Peer ID: ${localPeerId}`);
    } catch (error: any) {
        console.error("[Advertise] Failed to initialize Connection Manager or get Local Peer ID:", error);
        throw new Error(`Failed to get Peer ID for advertising: ${error.message}`);
    }

    // 2. Prepare Advertisement Data
    const serviceUUID = EWONIC_SIGNALING_SERVICE_UUID;
    let advertisementName = `${EWONIC_BLE_PREFIX}${localPeerId}`; // e.g., EWONIC:Peer_1234ABCD

    // --- Platform Specific Advertising ---

    // --- iOS Custom Native Module ---
    if (Platform.OS === 'ios') {
        if (!isIosAdvertiserAvailable || !EWonicBleAdvertiser.startAdvertising) {
             console.error("[Advertise] iOS: EWonicBleAdvertiser native module or startAdvertising method is not available.");
            throw new Error("iOS advertising module not available.");
        }

        // iOS name length is limited. Check and potentially truncate or use Service Data.
        const MAX_IOS_NAME_LENGTH = 20; // Conservative estimate, depends on other payload data
        if (advertisementName.length > MAX_IOS_NAME_LENGTH) {
            console.warn(`[Advertise] iOS Advertisement name "${advertisementName}" (${advertisementName.length} chars) might be too long. Consider using Service Data or shortening Peer ID format.`);
            // Truncating name risks breaking Peer ID discovery. Avoid if possible.
            // advertisementName = advertisementName.substring(0, MAX_IOS_NAME_LENGTH);
            // throw new Error("Peer ID too long for iOS advertisement name."); // Or handle differently
        }

        console.log(`[Advertise] Starting iOS Advertising: Name='${advertisementName}', Service UUID='${serviceUUID}'`);
        try {
            // Call the custom native module method
            await EWonicBleAdvertiser.startAdvertising(serviceUUID, advertisementName);
            console.log('[Advertise] Native iOS startAdvertising called (actual start is async and reported via event).');
        } catch (error: any) {
            console.error('[Advertise] iOS: Failed to call startAdvertising:', error.message, error.code);
            throw error; // Re-throw native error
        }
    }
    // --- Android (Placeholder - Requires Library/Native Module) ---
    else if (Platform.OS === 'android') {
        console.warn("[Advertise] Android advertising requires a dedicated library (e.g., react-native-ble-advertiser) or native module. Using placeholder logic.");
        // Example using react-native-ble-advertiser (adjust UUID format and options as needed)
        /*
        try {
            console.log(`[Advertise] Starting Android Advertising via hypothetical library...`);
            BleAdvertiser.setCompanyId(0xFFFF); // Example Manufacturer ID

            // Prepare service data (alternative way to send Peer ID)
            // const peerIdBytes = Buffer.from(localPeerId, 'utf8');
            // const serviceDataBytes = Array.from(peerIdBytes);

            await BleAdvertiser.broadcast(
                serviceUUID.replace(/-/g, ''), // Library might need UUID without dashes
                [], // Empty Manufacturer Data (or put Peer ID here if preferred)
                {
                    advertiseMode: BleAdvertiser.ADVERTISE_MODE_LOW_LATENCY, // Or BALANCED, LOW_POWER
                    txPowerLevel: BleAdvertiser.ADVERTISE_TX_POWER_MEDIUM,
                    localName: advertisementName, // Include name
                    serviceUuids: [serviceUUID.replace(/-/g, '')],
                    // serviceData: { // Service Data requires UUID mapping in some libs
                    //    [serviceUUID.replace(/-/g, '')]: serviceDataBytes
                    // },
                    includeDeviceName: false, // Set true if localName doesn't work reliably
                    includeTxPowerLevel: false,
                    connectable: true, // Allow GATT connections for signaling
                }
            );
            console.log('[Advertise] Android advertising started via hypothetical library.');
        } catch (error: any) {
            console.error('[Advertise] Android: Failed to start advertising:', error.message, error.code);
            throw new Error(`Android advertising failed: ${error.message}`);
        }
        */
       // For now, just log and don't throw an error to allow iOS testing.
        console.log(`[Advertise] Placeholder Android Advertising: Name='${advertisementName}', Service UUID='${serviceUUID}'`);
    } else {
         console.error(`[Advertise] Unsupported platform for advertising: ${Platform.OS}`);
         throw new Error(`Unsupported platform: ${Platform.OS}`);
    }
}

/**
 * Stops BLE advertising.
 */
export async function stop_ble_advertising(): Promise<void> {
     console.log('[Advertise] Attempting to stop BLE Advertising...');

     // --- iOS Custom Native Module ---
     if (Platform.OS === 'ios') {
         if (!isIosAdvertiserAvailable || !EWonicBleAdvertiser.stopAdvertising) {
             console.warn("[Advertise] iOS: EWonicBleAdvertiser native module or stopAdvertising method is not available. Cannot stop.");
             return;
         }
         try {
             await EWonicBleAdvertiser.stopAdvertising();
             console.log('[Advertise] Native iOS stopAdvertising called (actual stop reported via event).');
         } catch (error: any) {
             console.error('[Advertise] iOS: Failed to call stopAdvertising:', error.message, error.code);
             // Log error but don't throw during cleanup?
         }
     }
     // --- Android (Placeholder) ---
     else if (Platform.OS === 'android') {
         console.warn("[Advertise] Android stop advertising requires implementation.");
         /*
         try {
             await BleAdvertiser.stopBroadcast();
             console.log('[Advertise] Android advertising stopped via hypothetical library.');
         } catch (error: any) {
             console.error('[Advertise] Android: Failed to stop advertising:', error.message, error.code);
         }
         */
     }
}

// --- State Getters and Event Subscriptions (iOS Only via Native Module) ---

/**
 * Gets the current advertising state (iOS only via Native Module).
 * @returns {Promise<boolean>} True if advertising, false otherwise or if module unavailable.
 */
export async function get_is_advertising(): Promise<boolean> {
    if (!isIosAdvertiserAvailable || !EWonicBleAdvertiser.getAdvertisingState) {
         // console.warn("[Advertise] iOS: getAdvertisingState not available.");
         return false; // Assume not advertising if module unavailable
    }
    try {
        const isAdv = await EWonicBleAdvertiser.getAdvertisingState();
        // console.log("[Advertise] iOS: Got advertising state:", isAdv); // Debug
        return !!isAdv;
    } catch (error) {
        console.error("[Advertise] iOS: Error calling getAdvertisingState:", error);
        return false; // Default to false on error
    }
}

/**
 * Gets the current Bluetooth state (iOS only via Native Module).
 * @returns {Promise<string>} State string (e.g., "PoweredOn") or "Unknown".
 */
export async function get_bluetooth_state(): Promise<string> {
    if (!isIosAdvertiserAvailable || !EWonicBleAdvertiser.getBluetoothState) {
        // console.warn("[Advertise] iOS: getBluetoothState not available.");
        return "Unknown"; // Default if module unavailable
    }
     try {
        // State string directly from CBManagerState (e.g., "poweredOn")
        const nativeState = await EWonicBleAdvertiser.getBluetoothState();
        // console.log("[Advertise] iOS: Got native Bluetooth state:", nativeState); // Debug
        return mapNativeBluetoothState(nativeState) || "Unknown";
    } catch (error) {
        console.error("[Advertise] iOS: Error calling getBluetoothState:", error);
        return "Unknown";
    }
}

// Helper to map CoreBluetooth state names to ble-plx style names
function mapNativeBluetoothState(nativeState: string): string | null {
    const mapping: { [key: string]: string } = {
        "poweredOn": "PoweredOn",
        "poweredOff": "PoweredOff",
        "unauthorized": "Unauthorized",
        "unsupported": "Unsupported",
        "resetting": "Resetting",
        "unknown": "Unknown",
    };
    return mapping[nativeState] || nativeState; // Return mapped state or original if no match
}


/**
 * Subscribes to advertising and Bluetooth state change events (iOS only via Native Module).
 * @param {(isAdvertising: boolean) => void} onAdvertisingStateChange Callback for advertising state changes.
 * @param {(state: string) => void} onBluetoothStateChange Callback for Bluetooth state changes.
 * @returns {() => void} An unsubscribe function.
 */
export function subscribeToAdvertisingEvents(
    onAdvertisingStateChange: (isAdvertising: boolean) => void,
    onBluetoothStateChange: (state: string) => void
): () => void { // Returns an unsubscribe function

    if (!bleAdvertiserEmitter) {
        console.warn("[Advertise] iOS: Native Event Emitter not available. State updates will be missed.");
        return () => {}; // Return empty unsubscribe function
    }

    console.log("[Advertise] Subscribing to native iOS events (onAdvertisingStateChanged, onBluetoothStateChanged)...");
    unsubscribeFromAdvertisingEvents(); // Clear existing listeners first

    advertisingStateListener = bleAdvertiserEmitter.addListener(
        'onAdvertisingStateChanged', // Match exact event name from Swift
        (event: { isAdvertising: boolean }) => {
            console.log('[Advertise] iOS Event: onAdvertisingStateChanged received:', event);
            if (typeof event?.isAdvertising === 'boolean') {
                 onAdvertisingStateChange(event.isAdvertising);
            } else {
                 console.warn("[Advertise] Invalid event format for onAdvertisingStateChanged:", event);
            }
        }
    );

    bluetoothStateListener = bleAdvertiserEmitter.addListener(
        'onBluetoothStateChanged', // Match exact event name from Swift
        (event: { state: string }) => {
             console.log('[Advertise] iOS Event: onBluetoothStateChanged received:', event);
             if (typeof event?.state === 'string') {
                const mappedState = mapNativeBluetoothState(event.state) || "Unknown";
                onBluetoothStateChange(mappedState);
             } else {
                 console.warn("[Advertise] Invalid event format for onBluetoothStateChanged:", event);
             }
        }
    );

    // Return an unsubscribe function
    return unsubscribeFromAdvertisingEvents;
}

// Helper to remove listeners
function unsubscribeFromAdvertisingEvents() {
    if (advertisingStateListener) {
        advertisingStateListener.remove();
        advertisingStateListener = null;
         console.log("[Advertise] Unsubscribed from onAdvertisingStateChanged.");
    }
    if (bluetoothStateListener) {
        bluetoothStateListener.remove();
        bluetoothStateListener = null;
         console.log("[Advertise] Unsubscribed from onBluetoothStateChanged.");
    }
}