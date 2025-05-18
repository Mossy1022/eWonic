import WifiP2p from 'react-native-wifi-p2p';

// Import callback types defined in connection_manager
import { MessageCallback, ConnectionSuccessCallback, DisconnectionCallback } from './connection_manager';



// Module-level state
let on_data_received: MessageCallback | null = null;
let on_connect_success: ConnectionSuccessCallback | null = null;
let on_disconnect_callback: DisconnectionCallback | null = null;

// Declare variables - TypeScript will infer the type from the assignment later
// Or explicitly type them with the shape needed ({ remove: () => void })
let connectionInfoSubscription: { remove: () => void } | null = null;
let dataReceivedSubscription: { remove: () => void } | null = null;
let peersUpdatedSubscription: { remove: () => void } | null = null; // If you use it

let connectedDeviceAddress: string | null = null; // Track the address of the connected peer
let isInitialized = false; // Track initialization state


/**
 * Initialize WifiP2p and set up listeners if not already done.
 */
async function initializeWifiP2p(): Promise<void> {
  if (isInitialized) {
    // console.log('[WiFiDirect] Already initialized.');
    return;
  }
  console.log('[WiFiDirect] Initializing...');

  try {
    await WifiP2p.initialize();
    const enabled = await WifiP2p.isWifiP2pEnabled();
    if (!enabled) {
      console.log('[WiFiDirect] Wi-Fi P2P is disabled. Requesting user to enable...');
      // Consider prompting the user or handling this state appropriately
      // await WifiP2p.enable(); // This might show a system dialog
      throw new Error("Wi-Fi P2P is not enabled");
    }

    // Ensure previous listeners are cleaned up before adding new ones
    await cleanupListeners();

    // Subscribe to events
    connectionInfoSubscription = WifiP2p.subscribeOnEvent('connectionInfo', handleConnectionInfo);
    dataReceivedSubscription = WifiP2p.subscribeOnEvent('dataReceived', handleDataReceived);
    // 'peersUpdated' can be useful for discovery but less so for connection status
    // peersUpdatedSubscription = WifiP2p.subscribeOnEvent('peersUpdated', handlePeersUpdated);

    isInitialized = true;
    console.log('[WiFiDirect] Initialized and subscribed to events.');
  } catch (error) {
    console.error('[WiFiDirect] Initialization failed:', error);
    isInitialized = false; // Ensure state reflects failure
    await cleanupListeners(); // Clean up any partial subscriptions
    throw error; // Re-throw error
  }
}

/**
 * Connect to a device via Wi-Fi Direct using its address.
 * @param {string} deviceAddress - The MAC address of the target device.
 * @param {MessageCallback} on_message - Callback for incoming messages.
 * @param {ConnectionSuccessCallback} on_success - Callback on successful connection.
 * @param {DisconnectionCallback} on_disconnect - Callback on disconnection.
 */
export async function connect(
  deviceAddress: string,
  on_message: MessageCallback,
  on_success: ConnectionSuccessCallback,
  on_disconnect: DisconnectionCallback
): Promise<void> {
  console.log(`[WiFiDirect] Attempting to connect to address: ${deviceAddress}`);
  if (connectedDeviceAddress) {
      console.warn(`[WiFiDirect] Already connected to ${connectedDeviceAddress}. Disconnect first.`);
      throw new Error("Already connected");
  }

  on_data_received = on_message;
  on_connect_success = on_success;
  on_disconnect_callback = on_disconnect;

  try {
    await initializeWifiP2p(); // Ensure initialized

    console.log('[WiFiDirect] Calling WifiP2p.connect...');
    // Attempt connection. Note: Success/failure is typically asynchronous via events.
    await WifiP2p.connect(deviceAddress);
    console.log(`[WiFiDirect] Connect request sent to ${deviceAddress}. Waiting for connection confirmation via event...`);
    // The actual success/failure is handled in handleConnectionInfo

  } catch (err: any) {
    console.error(`[WiFiDirect] Error initiating connection to ${deviceAddress}:`, err);
    // Reset callbacks if initiation failed
    on_data_received = null;
    on_connect_success = null;
    on_disconnect_callback = null;
    throw err; // Re-throw error to be caught by LobbyScreen
  }
}

/**
 * Send raw audio frame as base64 to the connected peer(s).
 */
export async function send_audio_frame(pcm_base64: string): Promise<void> {
  // You could prefix the message with "AUDIO:" so the receiver
  // knows it's an audio frame instead of a normal text message
  try {
    await WifiP2p.sendMessage(`AUDIO:${pcm_base64}`);
  } catch (err) {
    console.warn('WifiDirect: Error sending audio frame:', err);
  }
}

/**
 * @description Send a message to the connected peer via Wi-Fi Direct.
 * @param {string} message - Message to send.
 * @returns {Promise<void>}
 */
/**
 * Send a message to the connected peer.
 */
export async function send_message(message: string): Promise<void> {
  if (!connectedDeviceAddress) {
    console.warn('[WiFiDirect] Cannot send message, not connected.');
    throw new Error("Not connected via Wi-Fi Direct");
  }
  try {
    // console.log(`[WiFiDirect] Sending message: ${message.substring(0, 50)}...`); // Log snippet
    await WifiP2p.sendMessage(message);
  } catch (err: any) {
    console.warn('[WiFiDirect] Error sending message:', err);
    // Check if the error indicates disconnection
    if (err.message?.includes('Not connected')) { // Example error check
        handleDisconnection(connectedDeviceAddress); // Trigger disconnect logic
    }
    throw err;
  }
}

/**
 * Disconnect from the current peer or cancel connection attempt.
 */
export async function disconnect(): Promise<void> {
  console.log('[WiFiDirect] Attempting to disconnect...');
  const wasConnectedTo = connectedDeviceAddress; // Store before clearing
  connectedDeviceAddress = null; // Assume disconnection starts now

  try {
    // These might throw errors if not applicable, which is fine
    await WifiP2p.cancelConnect();
  } catch (err) {
    // console.log("[WifiDirect] No connection attempt to cancel or already disconnected.");
  }
  try {
    await WifiP2p.removeGroup(); // Disconnects if owner, might fail if client
  } catch (err) {
    // console.log("[WifiDirect] Failed to remove group (might not be owner or already disconnected).");
  }

  // Trigger the disconnect callback if we were previously connected
  if (wasConnectedTo && on_disconnect_callback) {
    console.log(`[WiFiDirect] Manually triggered disconnect callback for ${wasConnectedTo}`);
    on_disconnect_callback(wasConnectedTo);
  }

  // Reset callbacks after disconnection
  // on_data_received = null;
  // on_connect_success = null;
  // on_disconnect_callback = null;

  // Consider whether to clean up listeners here or keep them for potential future connections
  // await cleanupListeners();
  // isInitialized = false;

  console.log('[WiFiDirect] Disconnect process completed.');
}

// --- Event Handlers ---

function handleConnectionInfo(info: { groupFormed: boolean; isGroupOwner: boolean; groupOwnerAddress: string | null }) {
  console.log('[WiFiDirect] Event: Connection Info Update:', info);
  const currentlyConnected = !!connectedDeviceAddress;

  if (info.groupFormed && info.groupOwnerAddress) {
    // Successfully connected or connection state confirmed
    const peerAddress = info.groupOwnerAddress; // Assuming this is the key identifier
    if (!currentlyConnected) {
        connectedDeviceAddress = peerAddress;
        console.log(`[WiFiDirect] Event: Connection established! Peer Address: ${connectedDeviceAddress}`);
        if (on_connect_success) {
            on_connect_success(connectedDeviceAddress);
        }
    } else if (connectedDeviceAddress !== peerAddress) {
         console.warn(`[WiFiDirect] Connected to a different peer (${peerAddress}) than expected (${connectedDeviceAddress}). Updating.`);
         connectedDeviceAddress = peerAddress; // Update if necessary
         // Decide if a disconnect/reconnect callback cycle is needed here
    } else {
        // console.log(`[WiFiDirect] Connection info confirms existing connection to ${connectedDeviceAddress}`);
    }
  } else {
    // Group dissolved or connection lost
    if (currentlyConnected) {
        handleDisconnection(connectedDeviceAddress);
    }
  }
}

function handleDataReceived(data: { message: string; type: string }) { // Type according to library if known
  // console.log('[WiFiDirect] Event: Data Received:', data.message.substring(0, 50)); // Log snippet
  if (on_data_received && data.message) {
    on_data_received(data.message);
  } else if (!on_data_received) {
      console.warn('[WiFiDirect] Received data but no callback is registered.');
  }
}

// Helper function to handle disconnection logic consistently
function handleDisconnection(disconnectedPeerAddress: string | null) {
    console.log(`[WiFiDirect] Handling disconnection from ${disconnectedPeerAddress || 'unknown peer'}.`);
    const wasConnectedTo = connectedDeviceAddress;
    connectedDeviceAddress = null; // Clear the connection state

    if (wasConnectedTo && on_disconnect_callback) {
        console.log(`[WiFiDirect] Triggering disconnect callback for ${wasConnectedTo}`);
        on_disconnect_callback(wasConnectedTo);
    } else if (on_disconnect_callback) {
        // If we weren't formally connected but something triggered disconnect logic
        console.log(`[WiFiDirect] Triggering disconnect callback (was not formally connected).`);
        on_disconnect_callback(null);
    }

    // Reset callbacks after disconnection
    // on_data_received = null;
    // on_connect_success = null;
    // on_disconnect_callback = null;
}


// Helper function to remove listeners
async function cleanupListeners(): Promise<void> {
  // console.log('[WiFiDirect] Cleaning up listeners...');
  connectionInfoSubscription?.remove();
  dataReceivedSubscription?.remove();
  peersUpdatedSubscription?.remove();
  connectionInfoSubscription = null;
  dataReceivedSubscription = null;
  peersUpdatedSubscription = null;
}
