// src/services/p2p/multipeer.ts
import { Platform, EmitterSubscription } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { Buffer } from 'buffer'; // Import Buffer for Base64 encoding

// --- Imports based on the library's index.d.ts / common usage ---
import {
    initSession, // The main function to start
    MPCSession,  // The session object type
    RNPeer,      // The peer object type
    PeerState,   // The state enum
    InitSessionOptions // Options for initSession
} from 'react-native-multipeer-connectivity';
import { handle_incoming_audio_frame } from '../audio/audio_receiver'; // For playing received audio

import { EWONIC_MULTIPEER_SERVICE_TYPE } from '../../config/p2p_config';
// Import callback types defined in connection_manager
import { MessageCallback, ConnectionSuccessCallback, DisconnectionCallback, PeerFoundCallback, PeerLostCallback } from './connection_manager';

// Module-level state
let session: MPCSession | null = null;
let localPeerDisplayName: string | null = null;
let localCmPeerId: string | null = null;

let foundPeers = new Map<string, RNPeer>();
let connectedPeers = new Map<string, RNPeer>();
let peerStates = new Map<string, PeerState>();

// Callbacks
let on_message_received: MessageCallback | null = null;
let on_connect_success: ConnectionSuccessCallback | null = null;
let on_disconnect_callback: DisconnectionCallback | null = null;
let on_peer_found_callback: PeerFoundCallback | null = null;
let on_peer_lost_callback: PeerLostCallback | null = null;

let isInitialized = false;
let isBrowsing = false;
let isAdvertising = false;
let serviceType: string = EWONIC_MULTIPEER_SERVICE_TYPE;

const eventSubscriptions: EmitterSubscription[] = [];

export async function initializeMultipeer(cmPeerId: string): Promise<void> {
    if (Platform.OS !== 'ios') {
        console.log('[Multipeer] Skipping initialization on non-iOS platform.');
        return;
    }
    if (isInitialized && session) {
        console.log('[Multipeer] Already initialized.');
        return;
    }
    if (!cmPeerId) {
         throw new Error("[Multipeer] Cannot initialize without a valid CM Peer ID for discovery info.");
    }

    console.log('[Multipeer] Initializing session...');
    try {
        remove_listeners();
        session = null;

        localCmPeerId = cmPeerId;
        localPeerDisplayName = await DeviceInfo.getDeviceName();
        const discoveryInfo = { cmPeerId: localCmPeerId };

        const sessionOptions: InitSessionOptions = {
            displayName: localPeerDisplayName,
            serviceType: serviceType,
            discoveryInfo: discoveryInfo,
        };

        session = initSession(sessionOptions);
        if (!session) {
             throw new Error("[Multipeer] initSession did not return a valid session object.");
        }

        console.log(`[Multipeer] Session object created for service '${serviceType}' with display name '${localPeerDisplayName}' and discovery info`, discoveryInfo);

        eventSubscriptions.push(session.onFoundPeer(handlePeerFound));
        eventSubscriptions.push(session.onLostPeer(handlePeerLost));
        eventSubscriptions.push(session.onPeerStateChanged(handlePeerStateChanged));
        eventSubscriptions.push(session.onReceivedPeerInvitation(handleReceivedInvitation));
        eventSubscriptions.push(session.onReceivedText(handleReceivedText)); // Primary handler for text and our "audio-as-text"
        // We are choosing not to use onReceivedData for now to simplify the audio path.
        // eventSubscriptions.push(session.onReceivedData(handleReceivedData));
        eventSubscriptions.push(session.onStartAdvertisingError(handleAdvertisingError));
        eventSubscriptions.push(session.onStartBrowsingError(handleBrowsingError));

        isInitialized = true;
        console.log('[Multipeer] Initialization and listener setup complete.');

    } catch (error) {
        console.error('[Multipeer] Initialization failed:', error);
        isInitialized = false;
        session = null;
        localCmPeerId = null;
        remove_listeners();
        throw error;
    }
}

export async function startMultipeerSession(
    onMessage: MessageCallback,
    onSuccess: ConnectionSuccessCallback,
    onDisconnect: DisconnectionCallback,
    onPeerFound: PeerFoundCallback,
    onPeerLost: PeerLostCallback
): Promise<void> {
    if (Platform.OS !== 'ios') return;
    if (!isInitialized || !session) {
        throw new Error("[Multipeer] Not initialized. Call initializeMultipeer first.");
    }
    if (isBrowsing || isAdvertising) {
         console.warn('[Multipeer] Session already active. Stopping and restarting.');
         await stopMultipeerSession();
    }

    console.log('[Multipeer] Starting advertising & browsing...');
    on_message_received = onMessage;
    on_connect_success = onSuccess;
    on_disconnect_callback = onDisconnect;
    on_peer_found_callback = onPeerFound;
    on_peer_lost_callback = onPeerLost;

    foundPeers.clear();
    connectedPeers.clear();
    peerStates.clear();

    try {
        await session!.advertize();
        isAdvertising = true;
        console.log('[Multipeer] Advertising started.');

        await session!.browse();
        isBrowsing = true;
        console.log('[Multipeer] Browsing started.');

    } catch (error) {
        console.error('[Multipeer] Error starting advertising/browsing:', error);
        isAdvertising = false; isBrowsing = false;
        await stopMultipeerSession().catch(stopErr => console.error("[Multipeer] Error during cleanup after start failure:", stopErr));
        throw error;
    }
}

export async function stopMultipeerSession(): Promise<void> {
    if (Platform.OS !== 'ios' || !session) return;
    if (!isBrowsing && !isAdvertising && connectedPeers.size === 0) {
        console.log('[Multipeer] Session already stopped or inactive.');
        return;
    }
    console.log('[Multipeer] Stopping session...');

    const wasAdvertising = isAdvertising;
    const wasBrowsing = isBrowsing;

    isAdvertising = false;
    isBrowsing = false;

    try {
        if (wasAdvertising && session.stopAdvertizing) await session.stopAdvertizing();
        console.log('[Multipeer] Advertising stopped.');
    } catch (error) { console.error('[Multipeer] Error stopping advertising:', error); }
    try {
         if (wasBrowsing && session.stopBrowsing) await session.stopBrowsing();
         console.log('[Multipeer] Browsing stopped.');
    } catch (error) { console.error('[Multipeer] Error stopping browsing:', error); }
    try {
        if (connectedPeers.size > 0 && session.disconnect) {
             console.log('[Multipeer] Initiating disconnect from all peers...');
             await session.disconnect();
             console.log('[Multipeer] Disconnect all initiated.');
        }
    } catch (error) { console.error('[Multipeer] Error initiating disconnect:', error); }
    finally {
        foundPeers.clear();
        connectedPeers.clear();
        peerStates.clear();
        console.log('[Multipeer] Internal peer state cleared during stop.');
    }
}

export async function invitePeer(peerId: string): Promise<void> {
    if (Platform.OS !== 'ios' || !session) return;
    const peerInfo = foundPeers.get(peerId);
    if (!peerInfo) {
        throw new Error(`[Multipeer] Cannot invite: Peer not found: ${peerId}`);
    }
    const currentState = peerStates.get(peerId);
    if (currentState === PeerState.connected || currentState === PeerState.connecting) {
        console.warn(`[Multipeer] Peer ${peerInfo.displayName} (${peerId.substring(0,6)}) is already ${currentState}. Ignoring invite.`);
        return;
    }
    console.log(`[Multipeer] Inviting peer: ${peerInfo.displayName} (${peerId.substring(0,6)})`);
    try {
        await session.invite(peerId);
    } catch (error) {
        console.error(`[Multipeer] Error inviting peer ${peerId.substring(0,6)}:`, error);
        throw error;
    }
}

export async function sendTextMessage(message: string, targetPeerIds?: string[]): Promise<void> {
    if (Platform.OS !== 'ios' || !session) return;
    if (connectedPeers.size === 0 && (!targetPeerIds || targetPeerIds.length === 0)) {
         console.warn("[Multipeer] Cannot send text: No connected peers or targets.");
         return;
    }

    let recipients: string[];
    if (targetPeerIds) {
        recipients = targetPeerIds.filter(id => connectedPeers.has(id));
        if (recipients.length !== targetPeerIds.length) {
             console.warn(`[Multipeer] Attempted to send text to non-connected/unknown peers: ${targetPeerIds.filter(id => !connectedPeers.has(id)).join(', ')}`);
        }
    } else {
        recipients = Array.from(connectedPeers.keys());
    }

    if (recipients.length === 0) {
         console.warn("[Multipeer] No valid connected recipients to send text to.");
         return;
    }

    for (const recipientId of recipients) {
        try {
            // console.log(`[Multipeer JS] Sending text to ${recipientId.substring(0,6)}: ${message.substring(0,30)}...`);
            await session.sendText(recipientId, message);
        } catch (error) {
            console.error(`[Multipeer] Error sending text to ${recipientId.substring(0,6)}:`, error);
        }
    }
}

/**
 * Converts Uint8Array audio frame to a prefixed Base64 string and sends it as text.
 * This function is called by `send_binary_audio_frame` in connection_manager for iOS.
 */
export async function sendBinaryData(
    bytes: Uint8Array,
    targetPeerIds?: string[],
  ): Promise<void> {
    if (Platform.OS !== 'ios' || !session) {
        console.warn('[Multipeer] sendBinaryData: Not iOS or session not available.');
        return;
    }
    if (connectedPeers.size === 0 && (!targetPeerIds || targetPeerIds.length === 0)) {
        console.warn("[Multipeer] sendBinaryData: No connected peers or targets.");
        return;
    }
  
    const recipients =
      targetPeerIds?.filter(id => connectedPeers.has(id)) ??
      Array.from(connectedPeers.keys());

    if (recipients.length === 0) {
        console.warn("[Multipeer] sendBinaryData: No valid recipients to send to.");
        return;
    }

    try {
        const base64Frame = Buffer.from(bytes).toString('base64');
        const messageToSend = `AUDIO:${base64Frame}`; // Add "AUDIO:" prefix

        for (const id of recipients) {
          // console.log(`[Multipeer JS] Sending AUDIO prefixed text (from sendBinaryData) to ${id.substring(0,6)}, data length: ${base64Frame.length}`); // Noisy
          await session.sendText(id, messageToSend); // Send as text
        }
    } catch (error) {
        console.error('[Multipeer] Error in sendBinaryData (sending as prefixed text):', error);
    }
}
  
export async function disconnectAllPeers(): Promise<void> {
    if (Platform.OS !== 'ios' || !session) return;
    if (connectedPeers.size > 0) {
        console.log('[Multipeer] Disconnecting all connected peers...');
        try {
             await session.disconnect();
        } catch (error) {
            console.error('[Multipeer] Error initiating disconnect:', error);
        }
    } else {
        console.log('[Multipeer] No peers currently connected to disconnect.');
    }
}

export function getConnectedPeerList(): string[] {
    if (Platform.OS !== 'ios') return [];
    return Array.from(connectedPeers.keys());
}

export async function cleanupMultipeer(): Promise<void> {
    if (Platform.OS !== 'ios') return;
    console.log('[Multipeer] Cleaning up...');
    await stopMultipeerSession();
    remove_listeners();
    session = null;
    isInitialized = false;
    localPeerDisplayName = null;
    localCmPeerId = null;
    on_message_received = null;
    on_connect_success = null;
    on_disconnect_callback = null;
    on_peer_found_callback = null;
    on_peer_lost_callback = null;
    console.log('[Multipeer] Cleanup complete.');
}

// --- Event Handlers (Internal) ---

function handlePeerFound(event: { peer: RNPeer; discoveryInfo?: Record<string, string>; }) {
    if (!event || !event.peer) { console.warn('[Multipeer] Invalid PeerFound event:', event); return; }
    const { peer, discoveryInfo } = event;
    if (foundPeers.has(peer.id)) return;
    console.log(`[Multipeer] Event: Peer Found - Name: ${peer.displayName}, ID: ${peer.id.substring(0,8)}, DiscoveryInfo:`, discoveryInfo);
    foundPeers.set(peer.id, peer);
    if (!peerStates.has(peer.id)) {
        peerStates.set(peer.id, PeerState.notConnected);
    }
    if (on_peer_found_callback) {
        on_peer_found_callback(peer, discoveryInfo);
    }
}

function handlePeerLost(event: { peer: RNPeer; }) {
    if (!event || !event.peer) { console.warn('[Multipeer] Invalid PeerLost event:', event); return; }
    const { peer } = event;
    if (foundPeers.has(peer.id)) {
        console.log(`[Multipeer] Event: Peer Lost - Name: ${peer.displayName}, ID: ${peer.id.substring(0,8)}`);
        foundPeers.delete(peer.id);
        peerStates.delete(peer.id);
        if (on_peer_lost_callback) {
            on_peer_lost_callback(peer.id);
        }
        if (connectedPeers.has(peer.id)) {
             console.log(`[Multipeer] Lost peer ${peer.id.substring(0,6)} was connected. Triggering disconnect.`);
             connectedPeers.delete(peer.id);
             if (on_disconnect_callback) {
                 on_disconnect_callback(peer.id, 'lost');
             }
        }
    }
}

function handlePeerStateChanged(event: { peer: RNPeer; state: PeerState; }) {
    if (!event || !event.peer) { console.warn('[Multipeer] Invalid PeerStateChanged event:', event); return; }
    const { peer, state } = event;
    const previousState = peerStates.get(peer.id);
    if (previousState === state) return;
    console.log(`[Multipeer] Event: State Changed for ${peer.displayName} (${peer.id.substring(0,8)}): ${previousState ?? 'unknown'} -> ${state}`);
    peerStates.set(peer.id, state);
    if (!foundPeers.has(peer.id)) {
        console.warn(`[Multipeer] State change for unknown peer ${peer.id.substring(0,6)}. Adding to found list.`);
        foundPeers.set(peer.id, peer);
    }
    if (state === PeerState.connected) {
        if (!connectedPeers.has(peer.id)) {
            console.log(`[Multipeer] Peer ${peer.displayName} (${peer.id.substring(0,8)}) CONNECTED.`);
            connectedPeers.set(peer.id, peer);
            if (on_connect_success) on_connect_success(peer.id);
        }
    } else if (state === PeerState.notConnected) {
        if (connectedPeers.has(peer.id)) {
            console.log(`[Multipeer] Peer ${peer.displayName} (${peer.id.substring(0,8)}) DISCONNECTED.`);
            connectedPeers.delete(peer.id);
            if (on_disconnect_callback) on_disconnect_callback(peer.id, 'disconnected');
        } else if (previousState === PeerState.connecting) {
             console.error(`[Multipeer] Peer ${peer.displayName} (${peer.id.substring(0,8)}) FAILED to connect.`);
             if (on_disconnect_callback) on_disconnect_callback(peer.id, 'failed');
        }
    } else if (state === PeerState.connecting) {
         console.log(`[Multipeer] Peer ${peer.displayName} (${peer.id.substring(0,8)}) is CONNECTING.`);
    }
}

function handleReceivedInvitation(event: {
    peer: RNPeer;
    context?: Record<string, any>;
    handler: (accept: boolean) => Promise<void>;
}) {
    if (!event || !event.peer || !event.handler) { console.warn('[Multipeer] Invalid ReceivedInvitation event:', event); return; }
    const { peer, context, handler } = event;
    console.log(`[Multipeer] Event: Received Invitation from: ${peer.displayName} (${peer.id.substring(0,8)}), Context:`, context);
    const currentConnectionCount = connectedPeers.size;
    const isPeerConnecting = peerStates.get(peer.id) === PeerState.connecting;
    if (currentConnectionCount === 0 && !isPeerConnecting) {
        console.log(`[Multipeer] Auto-accepting invitation from ${peer.displayName}`);
        handler(true).catch(err => console.error(`[Multipeer] Error accepting invitation from ${peer.id.substring(0,6)}:`, err));
    } else {
         console.log(`[Multipeer] Auto-rejecting invitation from ${peer.displayName}. Connected: ${currentConnectionCount}, Connecting to them: ${isPeerConnecting}.`);
         handler(false).catch(err => console.error(`[Multipeer] Error rejecting invitation from ${peer.id.substring(0,6)}:`, err));
    }
}

function handleReceivedText(event: { peer: RNPeer; text: string; }) {
    if (!event || !event.peer || typeof event.text !== 'string') {
        console.warn('[Multipeer] Invalid ReceivedText event:', event);
        return;
    }
    const { peer, text } = event;

    // Log the raw text received for debugging
    console.log(`[Multipeer DEBUG] RAW TEXT RECEIVED from ${peer.displayName} (${peer.id.substring(0,8)}). Length: ${text.length}. Starts with AUDIO: ${text.startsWith("AUDIO:")}`);
    if (text.length > 0 && text.length < 100) { // Log first few char codes for short, potentially garbled text
        let charCodes = [];
        for (let i = 0; i < Math.min(10, text.length); i++) {
            charCodes.push(text.charCodeAt(i));
        }
        console.log(`[Multipeer DEBUG] First char codes: ${charCodes.join(', ')}`);
    }

    if (text.startsWith("AUDIO:")) {
        const b64 = text.substring("AUDIO:".length);
        console.log(`[Multipeer] Processing AUDIO frame from ${peer.displayName}. Base64 length: ${b64.length}`);
        handle_incoming_audio_frame(b64) // This function is async but we don't need to await its playback completion here
            .catch(err => console.error(`[Multipeer] Error in handle_incoming_audio_frame for AUDIO prefixed text:`, err));
    } else {
        console.log(`[Multipeer] Received non-audio text from ${peer.displayName}: "${text.substring(0,100)}"`); // Log snippet of non-audio text
        // Handle other, non-audio text messages
        if (connectedPeers.has(peer.id) && on_message_received) {
            on_message_received(peer.id, text);
        } else if (!connectedPeers.has(peer.id)) {
            console.warn(`[Multipeer] Received text from non-connected peer ${peer.id.substring(0,6)}. Ignoring non-audio message.`);
        } else {
            console.warn(`[Multipeer] Received non-audio text from ${peer.id.substring(0,6)}, but no general message callback registered.`);
        }
    }
}

function handleAdvertisingError(event: { text: string }) {
    console.error(`[Multipeer] Advertising Error: ${event.text || JSON.stringify(event)}`);
    isAdvertising = false;
    if (on_disconnect_callback) {
        on_disconnect_callback(null, 'advertising_error');
    }
}

function handleBrowsingError(event: { text: string }) {
    console.error(`[Multipeer] Browsing Error: ${event.text || JSON.stringify(event)}`);
    isBrowsing = false;
    if (on_disconnect_callback) {
        on_disconnect_callback(null, 'browsing_error');
    }
}

function remove_listeners() {
    if (eventSubscriptions.length > 0) {
        console.log(`[Multipeer] Removing ${eventSubscriptions.length} event listeners...`);
        eventSubscriptions.forEach(sub => {
            try {
                 if (sub && typeof sub.remove === 'function') {
                     sub.remove();
                 }
            } catch (e) {
                console.error("[Multipeer] Error removing subscription", e);
            }
        });
        eventSubscriptions.length = 0;
    }
}