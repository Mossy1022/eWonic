// src/services/p2p/webrtc_connection.ts
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
  // MediaStream, // Keep if used later
} from 'react-native-webrtc';

// Define standard WebRTC state types often used as string literals
// These are based on the WebRTC spec, as the library likely doesn't export these specific types.
type RTCIceConnectionState = | 'new' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed';
type RTCSignalingState = | 'stable' | 'have-local-offer' | 'have-remote-offer' | 'have-local-pranswer' | 'have-remote-pranswer' | 'closed';
type RTCDataChannelState = | 'connecting' | 'open' | 'closing' | 'closed';

// Define callback types using the string literal types
export type SignalingMessageCallback = (targetPeerId: string | null, message: any) => void;
export type DataMessageCallback = (peerId: string, data: string) => void;
export type ConnectionStateCallback = (peerId: string, state: 'connecting' | 'connected' | 'disconnected' | 'failed') => void;

// Configuration for STUN/TURN servers
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Add TURN servers here if needed
];

// Define the structure for event objects based on WebRTC standards (use 'any' if specific types unknown)
interface RTCPeerConnectionIceEvent {
  candidate: RTCIceCandidate | null;
  // Other potential fields if needed
}

interface RTCDataChannelEvent {
  channel: any; // Use 'any' for RTCDataChannel type
  // Other potential fields if needed
}

// Interface for storing connection info
export interface PeerConnectionInfo {
  peerId: string;
  pc: RTCPeerConnection;
  dataChannel: any | null; // Use 'any' for RTCDataChannel type or find specific library type
  isInitiator: boolean;
}

// Store peer connections
const peerConnections = new Map<string, PeerConnectionInfo>();

let localPeerId: string | null = null;
let sendSignalingMessage: SignalingMessageCallback | null = null;
let onDataMessage: DataMessageCallback | null = null;
let onConnectionStateChange: ConnectionStateCallback | null = null;

/**
* Initialize the WebRTC connection module.
*/
export function initializeWebRTC(
  myPeerId: string,
  signalingCallback: SignalingMessageCallback,
  dataCallback: DataMessageCallback,
  stateCallback: ConnectionStateCallback
): void {
  console.log(`[WebRTC] Initializing with Peer ID: ${myPeerId}`);
  if (localPeerId && localPeerId !== myPeerId) {
      console.warn(`[WebRTC] Re-initializing with a different Peer ID. Previous: ${localPeerId}, New: ${myPeerId}. Cleaning up old connections.`);
      closeAllConnections();
  } else if (peerConnections.size > 0) {
      console.warn(`[WebRTC] Re-initializing. Cleaning up ${peerConnections.size} existing connections.`);
      closeAllConnections();
  }

  localPeerId = myPeerId;
  sendSignalingMessage = signalingCallback;
  onDataMessage = dataCallback;
  onConnectionStateChange = stateCallback;

  console.log("[WebRTC] Initialization complete.");
}

/**
* Create and configure an RTCPeerConnection. Internal use.
*/
function createPeerConnection(peerId: string, isInitiator: boolean): PeerConnectionInfo {
  if (peerConnections.has(peerId)) {
      console.warn(`[WebRTC] PeerConnection for ${peerId} already exists. Closing old one before creating new.`);
      closeConnection(peerId);
  }

  console.log(`[WebRTC] Creating PeerConnection for peer: ${peerId}, Initiator: ${isInitiator}`);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  const pcInfo: PeerConnectionInfo = { peerId, pc, dataChannel: null, isInitiator };
  peerConnections.set(peerId, pcInfo);

  // --- Assign Event Handlers using on... properties ---

  // Handle ICE candidates
  pc.onicecandidate = (event: RTCPeerConnectionIceEvent | null) => { // Event can be null
      if (!peerConnections.has(peerId)) return; // Check connection still exists
      // Ensure event and candidate exist before accessing
      if (event && event.candidate && sendSignalingMessage) {
          sendSignalingMessage(peerId, { type: 'candidate', candidate: event.candidate.toJSON() });
      }
  };

  // Handle ICE connection state changes
  pc.oniceconnectionstatechange = () => { // No event object passed
      const currentPcInfo = peerConnections.get(peerId);
      if (!currentPcInfo || currentPcInfo.pc !== pc) return;

      const iceState = pc.iceConnectionState as RTCIceConnectionState; // Use our defined type
      console.log(`[WebRTC] ICE Connection State for ${peerId}: ${iceState}`);

      const channelState = currentPcInfo.dataChannel?.readyState as RTCDataChannelState | undefined;

      switch (iceState) {
          case 'new':
          case 'checking':
              if (onConnectionStateChange) onConnectionStateChange(peerId, 'connecting');
              break;
          case 'connected':
          case 'completed':
              // Only transition to 'connected' state if the data channel is also open
              if (channelState === 'open') {
                  if (onConnectionStateChange) onConnectionStateChange(peerId, 'connected');
              } else {
                  console.log(`[WebRTC] ICE ${iceState} for ${peerId}, but DataChannel state is ${channelState}. State remains 'connecting'.`);
                  if (onConnectionStateChange) onConnectionStateChange(peerId, 'connecting');
              }
              break;
          case 'disconnected':
              console.warn(`[WebRTC] ICE Disconnected for ${peerId}.`);
              if (onConnectionStateChange) onConnectionStateChange(peerId, 'disconnected');
              break;
          case 'failed':
              console.error(`[WebRTC] ICE Connection Failed for ${peerId}.`);
              if (onConnectionStateChange) onConnectionStateChange(peerId, 'failed');
              closeConnection(peerId); // Close decisively
              break;
          case 'closed':
              console.log(`[WebRTC] ICE Connection Closed for ${peerId}.`);
               // Report disconnected state if not already failed
              if (onConnectionStateChange && peerConnections.has(peerId)) {
                  // Consider tracking last reported state to avoid duplicate 'disconnected' calls
                  onConnectionStateChange(peerId, 'disconnected');
              }
              // Remove from map AFTER potentially notifying
              peerConnections.delete(peerId);
              console.log(`[WebRTC] Removed peer ${peerId} from connections map. Total: ${peerConnections.size}`);
              break;
      }
  };

  // Handle remote data channel creation
  pc.ondatachannel = (event: RTCDataChannelEvent) => { // Event object expected
      const currentPcInfo = peerConnections.get(peerId);
      if (!currentPcInfo || currentPcInfo.pc !== pc) return;

      if (!event || !event.channel) {
          console.error(`[WebRTC] Invalid 'datachannel' event received for ${peerId}:`, event);
          return;
      }

      console.log(`[WebRTC] Received DataChannel from ${peerId}: ${event.channel.label}`);
      const receiveChannel = event.channel;
      if (!currentPcInfo.dataChannel) {
          currentPcInfo.dataChannel = receiveChannel;
          setupDataChannel(peerId, receiveChannel); // Setup listeners for the received channel
      } else {
          console.warn(`[WebRTC] Received unexpected second DataChannel from ${peerId} with label ${event.channel.label}. Current channel label: ${currentPcInfo.dataChannel.label}. Ignoring new one.`);
           try { receiveChannel.close(); } catch(e) {}
      }
  };

  // Optional: Monitor signaling state changes for debugging
  pc.onsignalingstatechange = () => { // No event object passed
      const currentPcInfo = peerConnections.get(peerId);
      if (!currentPcInfo || currentPcInfo.pc !== pc) return;
      const signalingState = pc.signalingState as RTCSignalingState; // Cast
      console.log(`[WebRTC] Signaling State for ${peerId}: ${signalingState}`);
  };

  return pcInfo;
}

/**
* Setup event listeners for a DataChannel. Internal use.
*/
function setupDataChannel(peerId: string, channel: any /* RTCDataChannel type */) {
  const pcInfo = peerConnections.get(peerId);
  if (!pcInfo || pcInfo.dataChannel !== channel) {
      console.error(`[WebRTC] Cannot setup DataChannel: pcInfo missing or channel mismatch for ${peerId}.`);
      if (channel) try { channel.close(); } catch(e) {}
      return;
  }

  console.log(`[WebRTC] Setting up DataChannel listeners for ${peerId} (Label: ${channel.label}, Current State: ${channel.readyState})`);

  // Use on... handlers for the data channel as well

  channel.onopen = () => { // No event object
      const currentPcInfo = peerConnections.get(peerId);
      // Check again inside the async callback
      if (!currentPcInfo || currentPcInfo.dataChannel !== channel) return;

      console.log(`[WebRTC] DataChannel opened for ${peerId}`);
      const iceState = currentPcInfo.pc.iceConnectionState as RTCIceConnectionState;
      // If ICE is connected/completed when channel opens, the whole connection is ready
      if ((iceState === 'connected' || iceState === 'completed') && onConnectionStateChange) {
          onConnectionStateChange(peerId, 'connected');
      } else {
           console.log(`[WebRTC] DataChannel opened for ${peerId}, but ICE state is ${iceState}. Still 'connecting'.`);
           if (onConnectionStateChange) onConnectionStateChange(peerId, 'connecting');
      }
  };

  channel.onclose = () => { // No event object
      const currentPcInfo = peerConnections.get(peerId);
      if (!currentPcInfo || currentPcInfo.dataChannel !== channel) return;

      console.log(`[WebRTC] DataChannel closed for ${peerId}`);
      const iceState = currentPcInfo.pc.iceConnectionState as RTCIceConnectionState;
      // Report disconnect if the main connection wasn't already failed/closed
      if (iceState !== 'failed' && iceState !== 'closed' && onConnectionStateChange) {
          onConnectionStateChange(peerId, 'disconnected');
      }
       // Setting pcInfo.dataChannel to null might be appropriate here if closed cleanly
       // currentPcInfo.dataChannel = null; // Consider implications
  };

  channel.onerror = (error: any /* RTCErrorEvent or generic Error */) => { // Error object passed
      const currentPcInfo = peerConnections.get(peerId);
      if (!currentPcInfo || currentPcInfo.dataChannel !== channel) return;
      console.error(`[WebRTC] DataChannel error for ${peerId}:`, error);
      if (onConnectionStateChange) {
           onConnectionStateChange(peerId, 'failed');
      }
      closeConnection(peerId); // Close associated PeerConnection on channel error
  };

  channel.onmessage = (event: MessageEvent) => { // Standard MessageEvent object
      const currentPcInfo = peerConnections.get(peerId);
      if (!currentPcInfo || currentPcInfo.dataChannel !== channel) return;

      if (!event) {
          console.warn(`[WebRTC] Received null/undefined message event from ${peerId}.`);
          return;
      }

      if (onDataMessage && typeof event.data === 'string') {
          onDataMessage(peerId, event.data);
      } else if (typeof event.data !== 'string') {
           console.warn(`[WebRTC] Received non-string data on channel from ${peerId}. Type: ${typeof event.data}. Data:`, event.data);
           // Handle ArrayBuffer or Blob if needed later
      } else if (!onDataMessage) {
           console.warn(`[WebRTC] DataChannel message received from ${peerId}, but no handler registered.`);
      }
  };
}

/**
* Initiate a WebRTC connection to a peer. Creates PeerConnection and DataChannel, then sends Offer.
*/
export async function initiateConnection(peerId: string): Promise<void> {
  if (!sendSignalingMessage || !localPeerId) {
      throw new Error('WebRTC module not initialized.');
  }
  if (peerId === localPeerId) {
      throw new Error('Cannot connect to self.');
  }

  // --- Check existing connection state ---
  const existingInfo = peerConnections.get(peerId);
  if (existingInfo) {
      const iceState = existingInfo.pc.iceConnectionState as RTCIceConnectionState;
      const signalingState = existingInfo.pc.signalingState as RTCSignalingState;
       if (iceState === 'connected' || iceState === 'completed' || iceState === 'connecting' || iceState === 'checking') {
          console.warn(`[WebRTC] Connection already exists or is in progress for ${peerId} (ICE State: ${iceState}). Aborting initiation.`);
           // Re-trigger state callback for consistency
          if (iceState === 'connected' || iceState === 'completed') {
              if(existingInfo.dataChannel?.readyState === 'open' && onConnectionStateChange) onConnectionStateChange(peerId, 'connected');
              else if (onConnectionStateChange) onConnectionStateChange(peerId, 'connecting');
          } else {
              if(onConnectionStateChange) onConnectionStateChange(peerId, 'connecting');
          }
          return; // Don't re-initiate
       } else if (signalingState !== 'closed' && signalingState !== 'stable') {
           // If ICE failed/disconnected but signaling is unstable, likely mid-cleanup or error state.
           console.warn(`[WebRTC] Cannot initiate connection to ${peerId} yet. Signaling state is ${signalingState}. Closing existing attempt.`);
           closeConnection(peerId); // Force close before trying again
           await new Promise(resolve => setTimeout(resolve, 100)); // Allow time for cleanup
       } else {
           // If failed/disconnected/closed and signaling is stable/closed, allow re-initiation.
           console.log(`[WebRTC] Re-initiating connection to ${peerId} after previous state (ICE: ${iceState}, Signaling: ${signalingState}).`);
       }
  }

  // --- Proceed with creating new connection ---
  const pcInfo = createPeerConnection(peerId, true); // true = initiator
  const { pc } = pcInfo;

  console.log(`[WebRTC] Creating DataChannel 'eWonicDataChannel' for ${peerId}`);
  // Options for the data channel (reliability, ordering)
  const dataChannelOptions = {
      ordered: true, // Ensure messages arrive in order
      // reliable: false, // Default is reliable (like TCP)
      // maxRetransmits: null, // For unreliable
  };
  try {
      const dataChannel: any = pc.createDataChannel('eWonicDataChannel', dataChannelOptions);
      pcInfo.dataChannel = dataChannel; // Store the created channel
      setupDataChannel(peerId, dataChannel); // Setup listeners immediately

      console.log(`[WebRTC] Creating SDP Offer for ${peerId}`);
      // Pass the options object, even if empty
      const offerOptions = {}; // Add constraints if needed, e.g., { offerToReceiveAudio: true }
      const offer = await pc.createOffer(offerOptions);
      await pc.setLocalDescription(offer);

      console.log(`[WebRTC] Sending SDP Offer to ${peerId}`);
      if (pc.localDescription && sendSignalingMessage) {
          sendSignalingMessage(peerId, { type: 'offer', sdp: pc.localDescription.toJSON() });
      } else {
          throw new Error("Local description not available after setLocalDescription.");
      }
  } catch (error) {
      console.error(`[WebRTC] Error during initiateConnection setup for ${peerId}:`, error);
      if (onConnectionStateChange) onConnectionStateChange(peerId, 'failed');
      closeConnection(peerId); // Clean up failed attempt
      throw error; // Re-throw error
  }
}

/**
* Handle incoming signaling messages (SDP Offers/Answers, ICE Candidates).
*/
export async function handleSignalingMessage(senderPeerId: string, message: any): Promise<void> {
  if (!sendSignalingMessage || !localPeerId) {
      console.error('[WebRTC] Received signaling message but not initialized.');
      return;
  }
  if (!message || !message.type || senderPeerId === localPeerId) {
      console.warn(`[WebRTC] Received invalid or self-sent signaling message from ${senderPeerId}:`, message);
      return;
  }

  console.log(`[WebRTC] Handling signaling message from ${senderPeerId}: ${message.type}`);

  let pcInfo = peerConnections.get(senderPeerId);
  const messageType = message.type;

  // --- Offer Handling & Glare Resolution ---
  if (messageType === 'offer') {
      if (!pcInfo) {
          console.log(`[WebRTC] Received offer from new peer ${senderPeerId}. Creating non-initiator connection.`);
          pcInfo = createPeerConnection(senderPeerId, false); // false = not initiator
      } else if (pcInfo.isInitiator) {
           console.warn(`[WebRTC] Glare condition: Received offer from ${senderPeerId}, but we are also initiating. Handling based on Peer ID comparison...`);
           // Simple glare resolution: higher ID yields (becomes non-initiator)
           if (localPeerId > senderPeerId) {
               console.log(`[WebRTC] Glare: Our ID (${localPeerId}) > Their ID (${senderPeerId}). Yielding. Aborting our initiation and accepting their offer.`);
               closeConnection(senderPeerId); // Close our attempt
               pcInfo = createPeerConnection(senderPeerId, false); // Recreate as non-initiator
           } else {
                console.log(`[WebRTC] Glare: Their ID (${senderPeerId}) > Our ID (${localPeerId}). Ignoring their offer.`);
                return; // Ignore their offer, let our `initiateConnection` proceed.
           }
      } else {
           // We are non-initiator and received another offer? This shouldn't happen if signaling is correct.
           console.warn(`[WebRTC] Received another offer from ${senderPeerId} while already in non-initiator state (${pcInfo.pc.signalingState}). Might indicate signaling issues. Re-processing.`);
           // Allow processing, setRemoteDescription might handle it correctly or throw error.
      }
  } else if (!pcInfo) {
      // Ignore answers/candidates if no connection exists for the sender
      console.warn(`[WebRTC] Received ${messageType} for unknown or inactive peer: ${senderPeerId}. Ignoring.`);
      return;
  }

  // Ensure pcInfo is valid after potential recreation due to glare
  if (!pcInfo) {
      console.error(`[WebRTC] Logic error: No PeerConnectionInfo found for ${senderPeerId} after potential glare handling for message type ${messageType}`);
      return;
  }

  // --- Process Message ---
  const { pc } = pcInfo;
  const signalingState = pc.signalingState as RTCSignalingState; // Cast
  console.log(`[WebRTC] Current signaling state for ${senderPeerId}: ${signalingState}`);

  try {
      if (messageType === 'offer') {
          // Check signaling state stability
          if (signalingState !== 'stable' && signalingState !== 'have-remote-offer' && signalingState !== 'closed') {
               // Glare should be handled above, but check again
              console.warn(`[WebRTC] Processing offer for ${senderPeerId} in unexpected signaling state (${signalingState}).`);
          }
          if (!message.sdp) throw new Error("Offer message missing sdp field.");
          await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
          console.log(`[WebRTC] Remote description (offer) set for ${senderPeerId}. Creating answer...`);

          const answer = await pc.createAnswer(); // No options usually needed for answer
          await pc.setLocalDescription(answer);

          console.log(`[WebRTC] Sending SDP Answer to ${senderPeerId}`);
          if (pc.localDescription && sendSignalingMessage) {
              sendSignalingMessage(senderPeerId, { type: 'answer', sdp: pc.localDescription.toJSON() });
          } else {
              throw new Error("Local description not available after createAnswer.");
          }

      } else if (messageType === 'answer') {
           // Should normally be in 'have-local-offer'. Can also be 'stable' if race condition/reordering.
           if (signalingState !== 'have-local-offer' && signalingState !== 'stable') {
               console.warn(`[WebRTC] Received answer for ${senderPeerId} in unexpected state (${signalingState}). Applying cautiously.`);
           }
           if (signalingState === 'closed') {
               console.warn(`[WebRTC] Received answer for ${senderPeerId} but connection is closed. Ignoring.`);
               return;
           }
          if (!message.sdp) throw new Error("Answer message missing sdp field.");
          await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
          console.log(`[WebRTC] Remote description (answer) set for ${senderPeerId}`);

      } else if (messageType === 'candidate') {
          if (message.candidate) {
               // Add candidate only if remote description is set and connection not closed
               if (pc.remoteDescription && signalingState !== 'closed') {
                  // console.log(`[WebRTC] Adding ICE candidate from ${senderPeerId}:`, message.candidate); // Noisy
                  await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
                  // console.log(`[WebRTC] Added ICE candidate from ${senderPeerId}`); // Noisy
               } else if (signalingState !== 'closed') {
                  console.warn(`[WebRTC] Received ICE candidate from ${senderPeerId} but remote description not yet set (SignalingState: ${signalingState}). Ignoring candidate.`);
                  // TODO: Implement candidate queueing if needed, but often unnecessary.
               } else {
                   // Ignore candidate for closed connection
                  // console.log(`[WebRTC] Ignoring ICE candidate for closed connection ${senderPeerId}.`);
               }
          } else {
               console.warn(`[WebRTC] Received candidate message from ${senderPeerId} without candidate payload.`);
          }
      } else {
          console.warn(`[WebRTC] Unknown signaling message type received from ${senderPeerId}: ${messageType}`);
      }
  } catch (error) {
      console.error(`[WebRTC] Error handling signaling message type ${messageType} from ${senderPeerId}:`, error);
       if (onConnectionStateChange) onConnectionStateChange(senderPeerId, 'failed');
       closeConnection(senderPeerId); // Clean up on error
  }
}


/**
* Send string data to a specific connected peer.
*/
export function sendData(peerId: string, data: string): void {
  const pcInfo = peerConnections.get(peerId);
  if (!pcInfo) return;

  // Check data channel state before sending
  const channelState = pcInfo.dataChannel?.readyState as RTCDataChannelState | undefined;
  if (channelState === 'open') {
      try {
          // console.log(`[WebRTC] Sending data to ${peerId}: ${data.substring(0, 50)}...`); // Noisy
          pcInfo.dataChannel.send(data);
      } catch (error) {
          console.error(`[WebRTC] Error sending data to ${peerId}:`, error);
          if (onConnectionStateChange) onConnectionStateChange(peerId, 'failed');
          closeConnection(peerId);
      }
  } else {
      // console.warn(`[WebRTC] Cannot send data to ${peerId}. Channel not ready (State: ${channelState}) or missing.`);
  }
}

/**
* Close the WebRTC connection to a specific peer and clean up resources.
*/
export function closeConnection(peerId: string): void {
  const pcInfo = peerConnections.get(peerId);
  if (pcInfo) {
      // Check if already closed to prevent redundant operations/logs
      const iceState = pcInfo.pc.iceConnectionState as RTCIceConnectionState;
      const signalingState = pcInfo.pc.signalingState as RTCSignalingState;
      if (iceState === 'closed' && signalingState === 'closed') {
          // console.log(`[WebRTC] Connection to ${peerId} already closed.`);
           peerConnections.delete(peerId); // Ensure removal if somehow missed
          return;
      }

      console.log(`[WebRTC] Closing connection to ${peerId}...`);

      // 1. Reset event handlers to prevent callbacks on closing/closed objects
      pcInfo.pc.onicecandidate = null;
      pcInfo.pc.oniceconnectionstatechange = null;
      pcInfo.pc.ondatachannel = null;
      pcInfo.pc.onsignalingstatechange = null;

      if (pcInfo.dataChannel) {
          const dc = pcInfo.dataChannel;
          dc.onopen = null;
          dc.onclose = null;
          dc.onerror = null;
          dc.onmessage = null;
          try {
              const dcState = dc.readyState as RTCDataChannelState;
              if (dcState !== 'closing' && dcState !== 'closed') {
                  dc.close();
              }
          } catch (e) {
              console.warn(`[WebRTC] Error closing data channel for ${peerId}:`, e);
          }
      }

      // 2. Close the PeerConnection
      try {
          if (signalingState !== 'closed') {
              pcInfo.pc.close(); // This should trigger 'closed' ICE state change eventually
              console.log(`[WebRTC] PeerConnection close() called for ${peerId}.`);
          }
      } catch (e) {
           console.warn(`[WebRTC] Error closing peer connection for ${peerId}:`, e);
      }

      // 3. Remove from map immediately *after* initiating close.
      const deleted = peerConnections.delete(peerId);
      if (deleted) {
          console.log(`[WebRTC] Removed peer ${peerId} from connections map during closeConnection call. Total: ${peerConnections.size}`);
      }

      // 4. Notify disconnect state if not already failed/closed
      if (iceState !== 'closed' && iceState !== 'failed' && onConnectionStateChange) {
           // Send 'disconnected' as the final state from explicit close
           onConnectionStateChange(peerId, 'disconnected');
      }

  } else {
       // console.log(`[WebRTC] Attempted to close non-existent connection: ${peerId}`);
  }
}


/**
* Close all active connections.
*/
export function closeAllConnections(): void {
  console.log(`[WebRTC] Closing all ${peerConnections.size} connections...`);
  const peerIds = Array.from(peerConnections.keys());
  peerIds.forEach(peerId => {
      closeConnection(peerId);
  });
  // Verify map is empty after loop (should be cleared by closeConnection or the 'closed' state handler)
  if (peerConnections.size > 0) {
       console.warn(`[WebRTC] Map not empty after closeAllConnections loop. Remaining: ${peerConnections.size}. Force clearing.`);
       peerConnections.clear(); // Force clear just in case
  }
   console.log(`[WebRTC] closeAllConnections complete.`);
}

/**
* Get the current ICE connection state for a peer.
*/
export function getConnectionState(peerId: string): RTCIceConnectionState | 'unknown' {
   const pcInfo = peerConnections.get(peerId);
   return pcInfo ? pcInfo.pc.iceConnectionState as RTCIceConnectionState : 'unknown';
}

/**
* Get the PeerConnectionInfo object for a peer.
*/
export function getPeerConnectionInfo(peerId: string): PeerConnectionInfo | null {
  return peerConnections.get(peerId) || null;
}

/**
* Get an array of peer IDs currently considered connected.
*/
export function getConnectedPeers(): string[] {
  const connected: string[] = [];
  peerConnections.forEach((info, peerId) => {
      const iceState = info.pc.iceConnectionState as RTCIceConnectionState;
      const channelState = info.dataChannel?.readyState as RTCDataChannelState | undefined;
      if ((iceState === 'connected' || iceState === 'completed') && channelState === 'open') {
          connected.push(peerId);
      }
  });
  return connected;
}