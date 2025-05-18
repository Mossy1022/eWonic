// src/screens/LobbyScreen.tsx
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
    View, Text, Button, FlatList, StyleSheet,
    TouchableOpacity, Platform, Switch, AppState,
    AppStateStatus, Alert, ActivityIndicator, EmitterSubscription // Correct type for AppState listener
} from 'react-native';
// Import Multipeer specific types for iOS handling
import { RNPeer, PeerState } from 'react-native-multipeer-connectivity';

// BLE Types (conditionally used)
import { Characteristic, BleError, BleErrorCode, Subscription as BleSubscription } from 'react-native-ble-plx';

// BLE Discovery/Advertising (Android/WebRTC Only)
import {
    DiscoveredDeviceInfo as BleDiscoveredDeviceInfo,
    start_ble_discovery,
    stop_ble_discovery,
    connectAndDiscoverSignaling, // Exported now
    writeSignalingMessage,
    subscribeToSignalingMessages,
    disconnectDevice as disconnectBleDevice
} from '../services/ble/ble_discovery';
import {
    start_ble_advertising,
    stop_ble_advertising,
    subscribeToAdvertisingEvents,
    get_bluetooth_state,
    get_is_advertising
} from '../services/ble/ble_advertise';

// P2P Connection Manager (Platform Agnostic Interface)
import {
    initializeManager as initConnectionManager,
    start_session, stop_session, connect_to_device,
    disconnect_peer, disconnect_all_peers, send_message,
    getLocalPeerId, getConnectedPeerIds,
    // WebRTC specific (conditionally used)
    subscribeToSignalingSend, receiveSignalingMessage,
    // Callbacks provided to start_session
    MessageCallback, ConnectionSuccessCallback, DisconnectionCallback,
    PeerFoundCallback, PeerLostCallback, cleanupManager,
} from '../services/p2p/connection_manager';

// Config
import { EWONIC_BLE_PREFIX } from '../config/ble_config';

// --- Define a unified Peer Type for the UI ---
interface DisplayPeer {
    id: string; // Unique ID (Multipeer ID on iOS, WebRTC Peer ID on Android)
    displayName: string; // User-friendly name
    platformSpecificId?: string; // e.g., Store BLE device ID for Android WebRTC signaling
    source: 'multipeer' | 'ble';
    discoveryInfo?: { [key: string]: any }; // Multipeer discovery info (optional)
    // Removed state as it's not directly on RNPeer, use connectionStatusMap instead
    // state?: PeerState | string;
    // Properties specific to BLE/WebRTC (Android)
    targetPeerId?: string | null; // WebRTC Peer ID parsed from BLE advertisement
    isConnectable?: boolean; // Derived from BLE advertisement data (Android)
}
// Type for signaling subscription cleanup (BLE Notifications)
type BleSignalingSubscription = BleSubscription;

export default function LobbyScreen({ onPeerConnected }: { onPeerConnected?: (peerId: string) => void }): any {
    // --- State ---
    const [discoveredPeers, setDiscoveredPeers] = useState<DisplayPeer[]>([]);
    const [isP2PSessionActive, setIsP2PSessionActive] = useState<boolean>(false);
    const [bluetoothState, setBluetoothState] = useState<string>("Unknown");
    const [messages, setMessages] = useState<string[]>([]);
    // Store the logical Peer ID mainly used for Android/WebRTC identification
    const [localPeerId, setLocalPeerId] = useState<string | null>(null);
    const [connectedPeerIds, setConnectedPeerIds] = useState<string[]>([]); // Stores IDs of connected peers (MPC or WebRTC)
    const [connectionStatusMap, setConnectionStatusMap] = useState<Record<string, 'idle' | 'inviting' | 'connecting' | 'connected' | 'disconnecting'>>({});
    const [isBusy, setIsBusy] = useState<boolean>(false);
    const [busyStatus, setBusyStatus] = useState<string>('Idle');

    // --- Android/WebRTC Specific State ---
    const signalingCharacteristicRef = useRef<Characteristic | null>(null);
    const signalingSubscriptionRef = useRef<BleSignalingSubscription | null>(null);
    const signalingTargetDeviceIdRef = useRef<string | null>(null); // BLE Device ID
    const signalingCmCleanupCallbackRef = useRef<(() => void) | null>(null); // Cleanup for CM signaling subscription
    const [isBleScanning, setIsBleScanning] = useState<boolean>(false);
    const [isBleAdvertising, setIsBleAdvertising] = useState<boolean>(false);

    // --- Ref for Mounted State ---
    const isMountedRef = useRef(true);

    // --- Logging ---
    const logMessage = useCallback((msg: string) => {
        console.log(`[LobbyScreen] ${msg}`);
        if (isMountedRef.current) {
            // Update messages state, keeping only the last 100
            setMessages(prev => [`${new Date().toLocaleTimeString()} ${msg}`, ...prev.slice(0, 99)]);
        }
    }, []);

    // --- Connection Status Update ---
    const updatePeerConnectionStatus = useCallback((peerId: string, status: 'idle' | 'inviting' | 'connecting' | 'connected' | 'disconnecting') => {
        logMessage(`Updating status for Peer ${peerId.substring(0, 6)} to ${status}`);
        // Use functional update to avoid stale state issues if called rapidly
        setConnectionStatusMap(prev => ({ ...prev, [peerId]: status }));
    }, [logMessage]);

    // --- P2P Callbacks (Provided to Connection Manager's start_session) ---

    // Called by CM when a message is received
    const handle_incoming_message = useCallback((peerId: string, msg: string) => {
        if (!isMountedRef.current) return;
        if (msg.startsWith('AUDIO:')) {
            // Placeholder for handling incoming audio frames
             logMessage(`Audio frame received from ${peerId.substring(0, 6)}`);
            // handle_incoming_audio_frame(msg.substring(6)); // If using audio receiver
        } else {
            logMessage(`Msg[${peerId.substring(0, 6)}]: ${msg}`);
        }
    }, [logMessage]);

    // Called by CM when a connection is successfully established
    const handle_connection_success = useCallback((peerId: string) => {
        if (!isMountedRef.current) return;
        logMessage(`System: Connected successfully to ${peerId.substring(0, 6)}`);
        updatePeerConnectionStatus(peerId, 'connected');
        setConnectedPeerIds(prev => [...new Set([...prev, peerId])]);
        setIsBusy(false);
        setBusyStatus("Connected");
        logMessage('[LobbyScreen] Calling onPeerConnected');
        if (Platform.OS === 'ios' && typeof onPeerConnected === 'function') {
          logMessage('[LobbyScreen] Calling onPeerConnected with peerId: ' + peerId);
          onPeerConnected(peerId);
        }
    }, [logMessage, updatePeerConnectionStatus, onPeerConnected]);

    // Called by CM when a peer disconnects or connection fails
    const handle_disconnection = useCallback((peerId: string | null, reason?: string) => {
        if (!isMountedRef.current) return;
        const targetPeer = peerId || 'unknown peer';
        logMessage(`System: Disconnected from ${targetPeer.substring(0, 6)}. Reason: ${reason || 'unknown'}`);

        if (peerId) {
            updatePeerConnectionStatus(peerId, 'idle'); // Reset status for this peer
            setConnectedPeerIds(prev => prev.filter(id => id !== peerId)); // Remove from connected list
        } else {
            // If peerId is null, it might indicate a session-level issue or disconnect all
             logMessage("System: Disconnected from all peers or session ended.");
             setConnectionStatusMap({}); // Reset all statuses
             setConnectedPeerIds([]); // Clear connected list
        }

        // If no longer connected to anyone, ensure busy state is false
        // Use functional update for connectedPeerIds check to get latest value
        setConnectedPeerIds(currentConnected => {
            if (currentConnected.length === 0) {
                 setIsBusy(false);
                 setBusyStatus("Idle");
            }
             return currentConnected; // Return the potentially updated array
        });


        // Specific cleanup for Android/WebRTC after disconnection
        if (Platform.OS !== 'ios' && peerId) {
            logMessage("[WebRTC Path] Cleaning up BLE GATT after disconnection.");
            // NOTE: cleanupBleGatt is defined later, ensure correct dependency handling or hoist
            cleanupBleGatt().catch(e => logMessage(`Error cleaning up BLE GATT: ${e}`));
            // Optionally restart BLE scanning if the session is still meant to be active
            if (isP2PSessionActive && !isBleScanning) {
                logMessage("[WebRTC Path] Restarting BLE discovery after disconnect.");
                 // NOTE: handle_peer_found is defined later, ensure correct dependency handling or hoist
                start_ble_discovery(handle_peer_found)
                   .then(() => { if (isMountedRef.current) setIsBleScanning(true); })
                   .catch(e => logMessage(`BLE Scan restart error: ${e}`));
            }
        }
    // Dependencies need to include functions defined later (handle carefully or hoist)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [logMessage, updatePeerConnectionStatus, isP2PSessionActive, isBleScanning]);

    // Called by CM when a peer is discovered (via BLE or Multipeer)
    const handle_peer_found = useCallback((peer: any, discoveryInfo?: Record<string, string>) => {
        if (!isMountedRef.current) return;
        let displayPeer: DisplayPeer | null = null;

        if (Platform.OS === 'ios') {
            // We expect an RNPeer object from the Multipeer integration via CM
            const multipeerInfo = peer as RNPeer; // Cast to RNPeer type
            if (!multipeerInfo || !multipeerInfo.id || !multipeerInfo.displayName) {
                logMessage(`[Warning] Received invalid peer object on iOS: ${JSON.stringify(peer)}`);
                return;
            }
            // Multipeer handles self-filtering. ID is the Multipeer internal ID.
            logMessage(`Peer Found (Multipeer): ${multipeerInfo.displayName} (${multipeerInfo.id.substring(0,6)}) Info: ${JSON.stringify(discoveryInfo)}`);
            displayPeer = {
                id: multipeerInfo.id, // Use Multipeer ID for list key and connection
                displayName: multipeerInfo.displayName || `iOS Device ${multipeerInfo.id.substring(0, 4)}`,
                source: 'multipeer',
                discoveryInfo: discoveryInfo, // Store discovery info from Multipeer
                // state: multipeerInfo.state, // ** REMOVED - state is not on RNPeer **
            };
        } else { // Android (Assume BLE discovery for WebRTC)
            const bleInfo = peer as BleDiscoveredDeviceInfo;
            // Use localPeerId state for self-check via BLE name/advertised ID
             if (bleInfo.targetPeerId && localPeerId && bleInfo.targetPeerId === localPeerId) {
                 // logMessage(`Found self via BLE: ${bleInfo.localName}`); // Can be noisy
                 return; // Don't add self to list
            }
            // Check if the BLE device is advertising our service and has a target Peer ID
            if (!bleInfo.isConnectable || !bleInfo.targetPeerId) {
                // logMessage(`Ignored non-connectable BLE device: ${bleInfo.localName || bleInfo.id}`);
                return; // Skip non-connectable or peers without the target ID
            }

            logMessage(`Peer Found (BLE): ${bleInfo.localName || 'Unknown'} (BLE ID: ${bleInfo.id.substring(0,6)}, Target ID: ${bleInfo.targetPeerId.substring(0,6)})`);
            // For Android/WebRTC, the 'id' for the DisplayPeer should be the target WebRTC Peer ID
            displayPeer = {
                id: bleInfo.targetPeerId, // Use WebRTC ID for list key and connection
                displayName: bleInfo.localName?.replace(EWONIC_BLE_PREFIX, '') || `Device ${bleInfo.targetPeerId.substring(0, 4)}`,
                source: 'ble',
                platformSpecificId: bleInfo.id, // Store the BLE device ID for GATT connection
                targetPeerId: bleInfo.targetPeerId, // Redundant but clear
                isConnectable: bleInfo.isConnectable, // Should be true here
            };
        }

        // Add or update the peer in the discoveredPeers state
        if (displayPeer) {
            setDiscoveredPeers((prev) => {
                const index = prev.findIndex(p => p.id === displayPeer!.id);
                if (index === -1) {
                    // Add new peer
                    return [...prev, displayPeer!];
                } else {
                    // Update existing peer (e.g., display name changed or re-discovered)
                    const updatedList = [...prev];
                    // Preserve connection status if peer is updated
                    const existingStatus = connectionStatusMap[displayPeer!.id];
                    updatedList[index] = displayPeer!;
                     // Ensure connectionStatusMap update if needed, though state is managed separately now
                     // Maybe re-trigger status update? updatePeerConnectionStatus(displayPeer!.id, existingStatus || 'idle');
                    return updatedList;
                }
            });
        }
    }, [logMessage, localPeerId, connectionStatusMap]); // Add connectionStatusMap dependency? Maybe not needed.

    // Called by CM when a previously found peer is lost
    const handle_peer_lost = useCallback((peerId: string) => {
        if (!isMountedRef.current) return;
        logMessage(`Peer Lost: ${peerId.substring(0, 6)}`);
        // Remove the peer from the discovered list
        setDiscoveredPeers((prev) => prev.filter(p => p.id !== peerId));
        // Remove any connection status associated with the lost peer
        setConnectionStatusMap(prev => {
            const newMap = { ...prev };
            delete newMap[peerId];
            return newMap;
        });
        // If the lost peer was connected, the handle_disconnection callback should handle it.
    }, [logMessage]);

     // --- Native BLE Event Handlers (Called by ble_advertise module) ---
     // Define these before handle_toggle_session which might depend on their state updates implicitly

    // Handles changes in the BLE advertising state (iOS or Android)
    const handleAdvertisingStateChange = useCallback((isNowAdvertising: boolean) => {
        if (!isMountedRef.current) return;
        logMessage(`Event (Native): Advertising state -> ${isNowAdvertising} (Platform: ${Platform.OS})`);
        setIsBleAdvertising(isNowAdvertising);
    }, [logMessage]);

    // Handles changes in the Bluetooth power state (iOS or Android)
    const handleBluetoothStateChange = useCallback((newState: string) => {
        if (!isMountedRef.current) return;
        logMessage(`Event (Native): Bluetooth state -> ${newState} (Platform: ${Platform.OS})`);
        setBluetoothState(newState);
        // If Bluetooth is turned off, stop the P2P session (handled within handle_toggle_session implicitly now)
        if (newState !== 'PoweredOn' && isP2PSessionActive) {
            logMessage("Warning: Bluetooth turned OFF. Triggering session stop.");
             // handle_toggle_session checks bluetoothState, so calling stop directly might be better here
             // Or rely on the check within handle_toggle_session when user tries to start again.
             // Let's call stop directly to be safe if session is active.
             handle_toggle_session(false); // Attempt to stop the session
            Alert.alert("Bluetooth Off", "P2P session has been stopped.");
        }
    // Add handle_toggle_session and isP2PSessionActive as dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [logMessage, isP2PSessionActive]);


    // --- Action Handlers (Button Presses, Switches) ---

    // Toggle the main P2P session (Advertising/Discovery)
    const handle_toggle_session = useCallback(async (value: boolean) => {
        // Check BT state *before* proceeding
        if (value && bluetoothState !== 'PoweredOn') {
            Alert.alert("Bluetooth Off", "Please turn on Bluetooth first.");
            return; // Don't attempt to start if BT is off
        }
        if (isBusy) { logMessage("Cannot toggle session: Busy."); return; }

        setIsBusy(true);
        const action = value ? 'Starting' : 'Stopping';
        setBusyStatus(`${action} P2P Session...`);
        logMessage(`System: ${action} P2P session...`);

        try {
            if (value) { // --- Start Session ---
                 setDiscoveredPeers([]); setConnectionStatusMap({}); setConnectedPeerIds([]); // Reset state
                 // Start platform-specific discovery/advertising *before* calling CM's start_session
                 if (Platform.OS !== 'ios') {
                     logMessage("Android/WebRTC: Starting BLE discovery...");
                     setIsBleScanning(true); // Update UI state
                     await start_ble_discovery(handle_peer_found); // Start BLE scanning
                 }
                 // Start the Connection Manager session (registers callbacks, starts Multipeer on iOS)
                 await start_session(
                     handle_incoming_message, handle_connection_success, handle_disconnection,
                     handle_peer_found, handle_peer_lost
                 );
                 setIsP2PSessionActive(true); // Mark session as active in state
                 // Start advertising (BLE on Android, Multipeer handled by start_session on iOS)
                 if (Platform.OS !== 'ios') {
                     logMessage("Android/WebRTC: Starting BLE advertising...");
                     try {
                         await start_ble_advertising();
                         // Advertising state might be updated via native event listener,
                         // but set it here for immediate feedback if event is delayed.
                         if(isMountedRef.current) setIsBleAdvertising(true);
                     } catch (advError: any) {
                         logMessage(`Error starting BLE advertising: ${advError.message}`);
                         // Decide if this is critical - maybe session can continue without advertising?
                         // Alert.alert("Advertising Error", `Could not start BLE advertising: ${advError.message}`);
                     }
                 } else {
                    // Advertising state on iOS should be updated by handleAdvertisingStateChange
                 }
            } else { // --- Stop Session ---
                 // Stop the Connection Manager session (stops Multipeer, clears callbacks)
                 await stop_session();
                 // State is updated within stop_session's finally block now, but update UI here too
                 setIsP2PSessionActive(false); // Mark session inactive

                 // Stop platform-specific discovery/advertising
                 if (Platform.OS !== 'ios') {
                     logMessage("Android/WebRTC: Stopping BLE discovery and advertising...");
                     stop_ble_discovery(); setIsBleScanning(false);
                     try { await stop_ble_advertising(); } catch (advError: any) { logMessage(`Error stopping BLE advertising: ${advError.message}`); }
                     setIsBleAdvertising(false);
                 } else {
                    // Stop iOS specific advertising if necessary (check if EWonicBleAdvertiser needs separate stop)
                    // try { await stop_ble_advertising(); } catch (advError: any) { logMessage(`Error stopping iOS BLE advertising: ${advError.message}`); }
                    setIsBleAdvertising(false); // Reflect state change
                 }
                 // Clear UI state after stopping
                 setDiscoveredPeers([]); setConnectionStatusMap({}); setConnectedPeerIds([]);
            }
            logMessage(`P2P Session ${action} successful.`);
        } catch (error: any) {
            logMessage(`Error ${action} P2P session: ${error.message}`);
            Alert.alert("Session Error", `Could not ${value ? 'start' : 'stop'} session: ${error.message}`);
             setIsP2PSessionActive(false); // Ensure inactive state on error
             // Attempt cleanup if starting failed
             if (value) {
                 // Call stop_session again for cleanup, just in case start partially succeeded
                 await stop_session().catch(e => logMessage(`Cleanup error after start fail: ${e}`));
                 if (Platform.OS !== 'ios') {
                    stop_ble_discovery(); setIsBleScanning(false);
                    await stop_ble_advertising().catch(e => logMessage(`BLE stop error: ${e}`)); setIsBleAdvertising(false);
                 } else {
                    setIsBleAdvertising(false);
                 }
                 setDiscoveredPeers([]); setConnectionStatusMap({}); setConnectedPeerIds([]);
             }
        } finally {
             if (isMountedRef.current) {
                 setIsBusy(false);
                 // Update busy status based on the *intended* final session state
                 setBusyStatus(value ? 'Active' : 'Idle');
             }
        }
    // Add all dependencies that the callback reads or sets
    }, [
        bluetoothState, isBusy, logMessage, handle_peer_found, handle_incoming_message,
        handle_connection_success, handle_disconnection, handle_peer_lost, isP2PSessionActive
    ]);

    // Convenience function for stopping the session
    const handle_stop_session = useCallback(async () => {
        // Only call toggle if it's currently active
        if (isP2PSessionActive) {
            await handle_toggle_session(false);
        } else {
            logMessage("Stop session called, but session already inactive.");
        }
    }, [handle_toggle_session, isP2PSessionActive]);


    // --- ANDROID/WEBRTC BLE GATT FUNCTIONS ---
    // Define these *before* handle_connect and handle_disconnect which use them

    // Cleans up the current BLE GATT connection and subscription
    const cleanupBleGatt = useCallback(async () => {
         if (Platform.OS === 'ios') return; // Only for Android
        // logMessage('[GATT] Cleaning up BLE GATT...'); // Can be noisy
        signalingSubscriptionRef.current?.remove();
        signalingSubscriptionRef.current = null;
        signalingCharacteristicRef.current = null;
        const deviceId = signalingTargetDeviceIdRef.current;
        signalingTargetDeviceIdRef.current = null; // Clear the target device ID ref
        if (deviceId) {
             await disconnectBleDevice(deviceId).catch(e => logMessage(`[GATT] Error during BLE disconnect: ${e}`));
        }
    }, [logMessage]); // logMessage is the only dependency

    // Sets up GATT connection and subscribes to the signaling characteristic
    const setupBleGattSignaling = useCallback(async (targetDeviceId: string, targetPeerId: string): Promise<boolean> => {
        if (Platform.OS === 'ios') return false; // Only for Android
        if (signalingTargetDeviceIdRef.current === targetDeviceId && signalingCharacteristicRef.current && signalingSubscriptionRef.current) {
            logMessage(`[GATT] Signaling already set up for Device ${targetDeviceId}`);
            return true;
        }
        await cleanupBleGatt(); // Clean up previous connection first
        logMessage(`[GATT] Setting up signaling for Device ${targetDeviceId}, Target Peer ${targetPeerId}`);
        signalingTargetDeviceIdRef.current = targetDeviceId; // Store target BLE device ID

        try {
            const characteristic = await connectAndDiscoverSignaling(targetDeviceId);
            signalingCharacteristicRef.current = characteristic; // Store characteristic ref
            logMessage(`[GATT] Found characteristic for ${targetPeerId}. Subscribing...`);
            signalingSubscriptionRef.current = subscribeToSignalingMessages(
                characteristic,
                (message) => { // Callback when a message is received over BLE
                    if (!isMountedRef.current) return;
                    // logMessage(`[GATT] Received signaling message via BLE notification.`); // Noisy
                    receiveSignalingMessage(targetPeerId, message); // Pass to CM
                }
            );
            logMessage(`[GATT] Subscribed to signaling notifications for ${targetPeerId}`);
            return true; // Setup successful
        } catch (error: any) {
            logMessage(`[GATT] Error setting up signaling for ${targetDeviceId}: ${error.message || error}`);
            await cleanupBleGatt(); // Clean up GATT if setup failed
            return false; // Setup failed
        }
    }, [logMessage, cleanupBleGatt]); // Include cleanupBleGatt in dependencies


    // Handle connection request to a specific peer
    // Now defined after GATT helpers
    const handle_connect = useCallback(async (peer: DisplayPeer) => {
        if (bluetoothState !== 'PoweredOn') { Alert.alert("Bluetooth Off", "Please turn on Bluetooth."); return; }
        if (isBusy || (Platform.OS !== 'ios' && connectedPeerIds.length > 0)) {
            logMessage(`Cannot connect: Busy (${isBusy}) or already connected (${connectedPeerIds.length > 0} on Android).`);
            return;
        }

        const targetPeerId = peer.id; // MPC ID on iOS, WebRTC ID on Android
        logMessage(`Attempting to connect to ${peer.displayName} (${targetPeerId.substring(0, 6)})...`);
        setIsBusy(true); setBusyStatus(`Connecting to ${peer.displayName}...`);
        updatePeerConnectionStatus(targetPeerId, 'connecting'); // Update UI state

        try {
            if (Platform.OS === 'ios') {
                await connect_to_device(targetPeerId);
                logMessage(`iOS: Invitation sent to ${targetPeerId.substring(0,6)}. Waiting...`);
            } else { // Android/WebRTC
                logMessage("Android/WebRTC: Stopping BLE discovery before connecting...");
                stop_ble_discovery(); setIsBleScanning(false);

                logMessage("Android/WebRTC: Setting up BLE GATT signaling...");
                const bleDeviceId = peer.platformSpecificId; // Get the BLE device ID
                if (!bleDeviceId || !peer.targetPeerId) throw new Error("Missing BLE Device ID or Target WebRTC Peer ID");

                const bleReady = await setupBleGattSignaling(bleDeviceId, peer.targetPeerId); // Use helper defined above
                if (!bleReady) throw new Error("BLE Signaling setup failed.");

                logMessage("BLE signaling ready. Initiating WebRTC connection...");
                await connect_to_device(peer.targetPeerId); // Use helper defined above (passes WebRTC ID)
                logMessage(`WebRTC connection initiated for ${peer.targetPeerId.substring(0,6)}. Waiting...`);
            }
             // Success handled by handle_connection_success callback
        } catch (error: any) {
            logMessage(`Error connecting to ${targetPeerId.substring(0, 6)}: ${error.message}`);
            Alert.alert("Connection Error", `Failed to connect: ${error.message}`);
            updatePeerConnectionStatus(targetPeerId, 'idle');
            setIsBusy(false); setBusyStatus('Error');

            if (Platform.OS !== 'ios') {
                 await cleanupBleGatt().catch(e => logMessage(`GATT cleanup error after connect fail: ${e}`)); // Use helper
                 if (isP2PSessionActive && !isBleScanning) {
                     logMessage("[WebRTC Path] Restarting BLE discovery after connect failure.");
                     start_ble_discovery(handle_peer_found) // Use callback defined above
                         .then(() => { if (isMountedRef.current) setIsBleScanning(true); })
                         .catch(e => logMessage(`BLE Scan restart error: ${e}`));
                 }
            }
        }
    // Add all dependencies, including the GATT helpers and peer found callback
    }, [
        bluetoothState, isBusy, connectedPeerIds, logMessage, updatePeerConnectionStatus,
        setupBleGattSignaling, cleanupBleGatt, isP2PSessionActive, isBleScanning, handle_peer_found
    ]);

    // Handle disconnection request from a specific peer
    // Now defined after GATT helpers
    const handle_disconnect = useCallback(async (peerId: string) => {
        if (isBusy) { logMessage("Cannot disconnect: Busy."); return; }
        logMessage(`Disconnecting from peer: ${peerId.substring(0, 6)}...`);
        setIsBusy(true); setBusyStatus(`Disconnecting from ${peerId.substring(0, 6)}...`);
        updatePeerConnectionStatus(peerId, 'disconnecting');

        try {
            await disconnect_peer(peerId); // Call CM disconnect
            // Confirmation/cleanup happens in handle_disconnection callback
        } catch (error: any) {
            logMessage(`Error initiating disconnect from ${peerId.substring(0, 6)}: ${error.message}`);
            Alert.alert("Disconnection Error", `Failed to initiate disconnect: ${error.message}`);
             // Revert UI status only if the *initiation* failed
             setConnectionStatusMap(prev => ({...prev, [peerId]: prev[peerId] === 'disconnecting' ? (connectedPeerIds.includes(peerId) ? 'connected' : 'idle') : prev[peerId] }));
             setIsBusy(false); setBusyStatus(isP2PSessionActive ? 'Active' : 'Idle');
        }
    }, [isBusy, logMessage, updatePeerConnectionStatus, connectedPeerIds, isP2PSessionActive]); // Add dependencies

    // Handles request from ConnectionManager (WebRTC module) to send a signaling message over BLE
    // Now defined after handle_disconnect and cleanupBleGatt
    const handleSignalingSendRequest = useCallback(async (payload: { targetPeerId: string, message: any }) => {
         if (Platform.OS === 'ios' || !isMountedRef.current) return;
        const { targetPeerId, message } = payload;
        if (!signalingCharacteristicRef.current || !signalingTargetDeviceIdRef.current) {
             logMessage(`[GATT] Error: Cannot send signaling message to ${targetPeerId}. BLE Signaling channel not ready.`);
             return;
         }
         const targetDisplayPeer = discoveredPeers.find(p => p.id === targetPeerId);
         if (targetDisplayPeer?.platformSpecificId !== signalingTargetDeviceIdRef.current) {
             logMessage(`[GATT] Error: Mismatch between signaling target Peer ID (${targetPeerId}) and current GATT device ID (${signalingTargetDeviceIdRef.current}). Aborting send.`);
              return;
         }

         try {
             const messageString = JSON.stringify(message);
             await writeSignalingMessage(signalingCharacteristicRef.current, messageString);
         } catch (error: any) {
             logMessage(`[GATT] Error writing signaling msg to ${targetPeerId} (Device: ${signalingTargetDeviceIdRef.current}): ${error.message || error}`);
             // Use BleErrorCode.DeviceDisconnected instead of DeviceConnectionLost
             if (error instanceof BleError && error.errorCode === BleErrorCode.DeviceDisconnected) {
                  logMessage("[GATT] Device disconnected during write. Triggering CM disconnect.");
                  await handle_disconnect(targetPeerId); // Use the disconnect handler
             } else {
                  await cleanupBleGatt().catch(e => logMessage(`GATT cleanup error after write fail: ${e}`)); // Use helper
             }
         }
    // Add dependencies, including the handlers it calls
    }, [logMessage, discoveredPeers, handle_disconnect, cleanupBleGatt]);


    // --- Initialization Effect ---
    useEffect(() => {
        isMountedRef.current = true;
        logMessage("Mounting LobbyScreen...");
        setIsBusy(true);
        setBusyStatus("Initializing...");

        let appStateListener: any | null = null; // Correct type
        let bleEventListener: (() => void) | null = null;

        const initialize = async () => {
            try {
                const cmPeerId = await initConnectionManager();
                if (!isMountedRef.current) return; // Check mount status after async call

                if (Platform.OS !== 'ios') setLocalPeerId(cmPeerId); // Only set state for Android/WebRTC
                logMessage(`CM Initialized. ${Platform.OS !== 'ios' ? `Local Peer ID: ${cmPeerId}` : '(iOS)'}`);


                const btState = await get_bluetooth_state();
                if (!isMountedRef.current) return;
                setBluetoothState(btState);
                if (btState !== 'PoweredOn') {
                    logMessage("Bluetooth is OFF.");
                    Alert.alert("Bluetooth Off", "Please turn on Bluetooth.");
                }

                // Setup listeners common to both platforms first if possible
                 bleEventListener = subscribeToAdvertisingEvents(
                    handleAdvertisingStateChange,
                    handleBluetoothStateChange
                 );

                // Platform-specific setups
                if (Platform.OS !== 'ios') {
                    logMessage("Android Platform: Setting up BLE/WebRTC signaling listener.");
                    signalingCmCleanupCallbackRef.current = subscribeToSignalingSend(handleSignalingSendRequest);
                    logMessage("Subscribed to CM signaling send requests.");
                    get_is_advertising().then(advState => { if (isMountedRef.current) setIsBleAdvertising(advState); });
                } else {
                     logMessage("iOS Platform: Multipeer initialized. Getting initial advertising state...");
                      get_is_advertising().then(advState => { if (isMountedRef.current) setIsBleAdvertising(advState); });
                }

                // App State Listener
                const handleAppStateChange = async (nextAppState: AppStateStatus) => {
                     if (!isMountedRef.current) return; // Check mount status in listener
                     logMessage(`App State Changed: ${nextAppState}`);
                     if (nextAppState === 'active') {
                         logMessage('App active, re-checking BT state...');
                         const state = await get_bluetooth_state();
                          if (!isMountedRef.current) return;
                         setBluetoothState(state);
                         get_is_advertising().then(advState => { if (isMountedRef.current) setIsBleAdvertising(advState); });
                     } else if (nextAppState === 'background' || nextAppState === 'inactive') {
                         if (isP2PSessionActive) { // Only stop if active
                             logMessage('App inactive/background. Stopping P2P session...');
                             await handle_stop_session(); // Use stop handler
                         }
                     }
                };
                appStateListener = AppState.addEventListener('change', handleAppStateChange);

            } catch (error: any) {
                 if (isMountedRef.current) {
                     logMessage(`Error: Initialization failed - ${error.message}`);
                     Alert.alert("Initialization Error", `Failed to initialize: ${error.message}`);
                 }
            } finally {
                 if (isMountedRef.current) {
                     setIsBusy(false);
                     setBusyStatus("Idle");
                 }
            }
        };
        initialize();

        // Cleanup function
        return () => {
            isMountedRef.current = false;
            logMessage("Unmounting LobbyScreen...");
            setIsBusy(true); setBusyStatus("Cleaning up..."); // Show cleanup state
            appStateListener?.remove();
            bleEventListener?.(); // Corrected variable name
            if (Platform.OS !== 'ios') {
                 signalingCmCleanupCallbackRef.current?.();
                 cleanupBleGatt(); // Ensure GATT is cleaned up on Android
            }
        };
    // Rerun dependencies carefully chosen. Most logic is in useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);


    // --- Render ---

    // Render individual peer item in the FlatList
    const renderPeerItem = ({ item }: { item: DisplayPeer }) => {
        const currentStatus = connectionStatusMap[item.id] || 'idle';
        const isConnectedToThis = currentStatus === 'connected';
        const isConnectingToThis = currentStatus === 'connecting' || currentStatus === 'inviting';
        const isDisconnectingFromThis = currentStatus === 'disconnecting';

        // Determine if the connect/disconnect button should be disabled
        let buttonDisabled = isBusy || !isP2PSessionActive || isConnectingToThis || isDisconnectingFromThis;
        let buttonTitle = 'Connect';
        let buttonColor = '#007AFF'; // Blue for connect

        if (isConnectedToThis) {
            buttonTitle = 'Disconnect';
            buttonDisabled = isBusy || isDisconnectingFromThis; // Disable only if busy or already disconnecting
            buttonColor = '#FF3B30'; // Red for disconnect
        } else if (isConnectingToThis) {
            buttonTitle = 'Connecting...';
            buttonDisabled = true; // Always disabled while connecting
            buttonColor = '#FF9500'; // Orange for connecting
        } else if (isDisconnectingFromThis) {
             buttonTitle = 'Disconnecting...';
             buttonDisabled = true; // Always disabled while disconnecting
             buttonColor = '#8E8E93'; // Grey for disconnecting
        } else if (Platform.OS !== 'ios' && connectedPeerIds.length > 0) {
             // On Android, disable connect if already connected to someone else
             buttonTitle = 'Busy';
             buttonDisabled = true;
             buttonColor = '#8E8E93'; // Grey for busy
        }

        // Final check for non-connectable BLE devices
        if (item.source === 'ble' && !item.isConnectable) {
            buttonTitle = 'Not Connectable';
            buttonDisabled = true;
            buttonColor = '#8E8E93'; // Grey
        }

        return (
            <View style={styles.item_container}>
                <View style={styles.item_text_container}>
                    <Text style={styles.item_text} numberOfLines={1} ellipsizeMode="tail">
                        {item.displayName}
                         {/* Display Multipeer connection status derived from map */}
                         {item.source === 'multipeer' && currentStatus !== 'idle' &&
                            <Text style={styles.peerStateText}> [{currentStatus}]</Text>
                         }
                    </Text>
                     {/* Optionally show Peer ID snippet */}
                     <Text style={styles.peerIdText}>ID: {item.id.substring(0, 6)}... ({item.source})</Text>
                </View>
                <TouchableOpacity
                    style={[ styles.connect_button, { backgroundColor: buttonColor }, buttonDisabled ? styles.connect_button_disabled : {} ]}
                    onPress={() => { if (isConnectedToThis) handle_disconnect(item.id); else handle_connect(item); }}
                    disabled={buttonDisabled}
               >
                    <Text style={styles.connect_button_text}>{buttonTitle}</Text>
                </TouchableOpacity>
            </View>
        );
    };

    const currentActionLabel = isBusy ? busyStatus : (isP2PSessionActive ? 'Active' : 'Idle');

    // Main component layout
    return (
        <View style={styles.container}>
            {/* Header */}
            <Text style={styles.title}>eWonic P2P Lobby</Text>
            <Text style={styles.statusText}>
                 BT: {bluetoothState} | Advertising: {isBleAdvertising ? 'ON' : 'OFF'} | Scanning: {isBleScanning ? 'ON' : 'OFF'} | Session: {currentActionLabel}
            </Text>
            {isBusy && <ActivityIndicator size="small" color="#007AFF" style={styles.activityIndicator} />}
             <Text style={styles.statusTextSmall}>My Logical Peer ID (Android): {localPeerId?.substring(0, 12) || (Platform.OS === 'ios' ? 'N/A (iOS uses internal ID)' : 'Initializing...')}</Text>

            {/* Session Toggle */}
            <View style={styles.controlRow}>
                <Text style={styles.controlLabel}>Activate P2P Session:</Text>
                <Switch
                    trackColor={{ false: "#767577", true: "#81b0ff" }}
                    thumbColor={isP2PSessionActive ? "#007AFF" : "#f4f3f4"}
                    ios_backgroundColor="#3e3e3e"
                    onValueChange={handle_toggle_session}
                    value={isP2PSessionActive}
                    disabled={bluetoothState !== 'PoweredOn' || isBusy} // Disable if BT off or busy
                 />
            </View>

            {/* Device List */}
            <Text style={styles.listTitle}>Nearby Devices ({discoveredPeers.length}):</Text>
            <FlatList
                 data={discoveredPeers}
                 keyExtractor={(item) => item.id} // Use the unified ID (MPC or WebRTC)
                 style={styles.deviceList}
                 renderItem={renderPeerItem}
                 ListEmptyComponent={<Text style={styles.emptyListText}>{isP2PSessionActive ? (isBleScanning || Platform.OS === 'ios' ? 'Scanning...' : 'Activate Scan?') : 'Activate Session to find users.'}</Text>}
                 // Ensure list re-renders when connection status or peer list changes
                 extraData={{ connectionStatusMap, discoveredPeersLength: discoveredPeers.length, isP2PSessionActive, isBusy }}
             />

             {/* Connected Peers List */}
             <Text style={styles.listTitle}>Connected ({connectedPeerIds.length}):</Text>
             <View style={styles.connectedPeersContainer}>
                 {connectedPeerIds.length > 0 ? (
                     connectedPeerIds.map(id => {
                         // Find the peer's display name from the discovered list
                         const peer = discoveredPeers.find(p => p.id === id);
                         // If peer isn't in discoveredPeers (maybe lost?), still show ID
                         const name = peer?.displayName || `Peer ${id.substring(0, 6)}`;
                         return <Text key={id} style={styles.connectedPeerText}>- {name}</Text>;
                     })
                 ) : (
                     <Text style={styles.emptyListText}>Not connected.</Text>
                 )}
             </View>

            {/* Log Area */}
            <Text style={styles.listTitle}>Log:</Text>
            <FlatList
                 data={messages}
                 keyExtractor={(m, idx) => `msg-${idx}`}
                 style={styles.messageList}
                 inverted // Show latest messages at the bottom
                 renderItem={({ item }) => <Text style={styles.message} numberOfLines={1} ellipsizeMode="tail">{item}</Text>}
                 ListEmptyComponent={<Text style={styles.emptyListText}>No log messages yet.</Text>}
             />
        </View>
    ); // End of component return

} // End of LobbyScreen component

// --- Styles ---
// (Styles remain the same as previous version)
const styles = StyleSheet.create({
    container: {
        flex: 1,
        paddingTop: Platform.OS === 'ios' ? 50 : 30, // More padding for iOS notch/island
        paddingHorizontal: 16,
        paddingBottom: 20,
        backgroundColor: '#f8f9fa', // Light background
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        textAlign: 'center',
        marginBottom: 10,
        color: '#343a40', // Dark grey title
    },
    statusText: {
        textAlign: 'center',
        marginBottom: 2,
        color: '#555',
        fontSize: 11, // Smaller status text
        fontWeight: '500',
        flexWrap: 'wrap', // Allow text wrapping
    },
    statusTextSmall: {
        textAlign: 'center',
        marginBottom: 10,
        color: '#6c757d', // Lighter grey
        fontSize: 11,
    },
    activityIndicator: {
        marginVertical: 5, // Add vertical margin
    },
    controlRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 20,
        marginBottom: 15, // More margin below controls
        borderWidth: 1,
        borderColor: '#e0e0e0', // Lighter border
        borderRadius: 8,
        backgroundColor: '#ffffff', // White background for controls
    },
    controlLabel: {
        fontSize: 16,
        fontWeight: '500',
        color: '#495057', // Medium grey text
    },
    listTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 8,
        marginTop: 15, // Add margin top
        color: '#343a40',
    },
    deviceList: {
        flex: 3, // Allocate more space to device list
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#e0e0e0',
        borderRadius: 8,
        backgroundColor: '#ffffff',
    },
    messageList: {
        flex: 2, // Allocate less space to log
        borderWidth: 1,
        borderColor: '#e0e0e0',
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 5,
        backgroundColor: '#ffffff',
        minHeight: 100, // Ensure minimum height
    },
    item_container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12, // Slightly less padding
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#eee', // Lighter separator
    },
    item_text_container: { // Container for text elements
        flex: 1,
        marginRight: 10,
    },
    item_text: {
        fontSize: 15,
        color: '#495057',
        fontWeight: '500', // Slightly bolder name
    },
    peerIdText: { // Style for the Peer ID snippet
        fontSize: 10,
        color: '#6c757d',
        marginTop: 2,
    },
    peerStateText: { // Style for Multipeer state [connected], etc.
        fontSize: 11,
        color: '#007AFF', // Blue
        marginLeft: 5,
        fontWeight: 'normal',
    },
    connect_button: {
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 6,
        minWidth: 95, // Slightly wider button
        alignItems: 'center',
        justifyContent: 'center',
    },
    connect_button_disabled: {
        backgroundColor: '#ced4da', // Grey for disabled
        opacity: 0.7,
    },
    connect_button_text: {
        color: '#fff', // White text
        fontSize: 13, // Slightly smaller button text
        fontWeight: '500',
        textAlign: 'center',
    },
    message: {
        fontSize: 11,
        paddingVertical: 3,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0', // Very light separator
        color: '#6c757d',
        fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', // Monospace for logs
    },
    emptyListText: {
        textAlign: 'center',
        marginTop: 20, // More margin for empty text
        marginBottom: 15,
        paddingHorizontal: 10,
        fontSize: 14,
        color: '#888', // Medium grey
    },
    connectedPeersContainer: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        minHeight: 40,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#d6e9c6', // Light green border
        borderRadius: 8,
        backgroundColor: '#f0fff0', // Very light green background
    },
    connectedPeerText: {
        fontSize: 14,
        color: '#3c763d', // Darker green text
        marginBottom: 3,
        fontWeight: '500',
    },
});