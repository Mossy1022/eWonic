// eWonic/src/services/p2p/connection_manager.ts
/* eslint-disable max-lines */

import { Platform } from 'react-native'
import DeviceInfo from 'react-native-device-info'
import { EventEmitter } from 'eventemitter3'
import { Buffer } from 'buffer'

import * as WebRTC from './webrtc_connection'
import * as Multipeer from './multipeer'
import { RNPeer } from 'react-native-multipeer-connectivity'

///////////////////////////////////////////////////////////////////////////////
// Public callback types
///////////////////////////////////////////////////////////////////////////////
export type MessageCallback = (peerId: string, msg: string) => void
export type ConnectionSuccessCallback = (peerId: string) => void
export type DisconnectionCallback = (
  peerId: string | null,
  reason?: string,
) => void
export type PeerFoundCallback = (
  peer: any,
  discoveryInfo?: Record<string, string>,
) => void
export type PeerLostCallback = (peerId: string) => void

///////////////////////////////////////////////////////////////////////////////
// Private globals
///////////////////////////////////////////////////////////////////////////////
const signalingEmitter = new EventEmitter()
export const SIGNALING_EVENT_SEND = 'SIGNALING_SEND'
export const SIGNALING_EVENT_RECEIVE = 'SIGNALING_RECEIVE'

let localPeerId: string | null = null
let isManagerInitialized = false
let isSessionActive = false

let externalMessageCallback: MessageCallback | null = null
let externalConnectSuccessCallback: ConnectionSuccessCallback | null = null
let externalDisconnectCallback: DisconnectionCallback | null = null
let externalPeerFoundCallback: PeerFoundCallback | null = null
let externalPeerLostCallback: PeerLostCallback | null = null

///////////////////////////////////////////////////////////////////////////////
// Binary-audio helper (iOS raw binary -> MPC; Android falls back to base-64)
///////////////////////////////////////////////////////////////////////////////
export async function send_binary_audio_frame(
  frame: Uint8Array,
  target?: string,
) {
  if (Platform.OS === 'ios') {
    await Multipeer.sendBinaryData(frame, target ? [target] : undefined)
  } else {
    const b64 = Buffer.from(frame).toString('base64')
    await send_audio_frame(b64, target)
  }
}

///////////////////////////////////////////////////////////////////////////////
// Initialization
///////////////////////////////////////////////////////////////////////////////
export async function initializeManager(): Promise<string> {
  if (isManagerInitialized && localPeerId) return localPeerId

  const uniqueId = await DeviceInfo.getUniqueId()
  localPeerId = `Peer_${uniqueId.slice(0, 8)}`
  console.log(`[CM] Local peer ID: ${localPeerId}`)

  if (Platform.OS === 'ios') {
    await Multipeer.initializeMultipeer(localPeerId)
  } else {
    WebRTC.initializeWebRTC(
      localPeerId,
      handleWebRTCSignalingSend,
      handleIncomingData,
      handleConnectionState,
    )

    signalingEmitter.removeAllListeners(SIGNALING_EVENT_RECEIVE)
    signalingEmitter.on(
      SIGNALING_EVENT_RECEIVE,
      ({ senderPeerId, message }: { senderPeerId: string; message: any }) =>
        WebRTC.handleSignalingMessage(senderPeerId, message).catch(console.error),
    )
  }

  isManagerInitialized = true
  return localPeerId
}

///////////////////////////////////////////////////////////////////////////////
// Internal handlers
///////////////////////////////////////////////////////////////////////////////
function handleIncomingData(peerId: string, data: string) {
  externalMessageCallback?.(peerId, data)
}

function handleConnectionState(
  peerId: string,
  state: 'connecting' | 'connected' | 'disconnected' | 'failed',
) {
  console.log(`[CM] ${peerId} → ${state}`)
  if (state === 'connected') externalConnectSuccessCallback?.(peerId)
  else if (state === 'disconnected' || state === 'failed')
    externalDisconnectCallback?.(peerId, state)
}

function handlePeerFound(peerInfo: any, discovery?: Record<string, string>) {
  if (Platform.OS === 'ios' && (peerInfo as RNPeer)?.id) {
    const p = peerInfo as RNPeer
    console.log(
      `[CM] Peer found (iOS): ${p.displayName} (${p.id.slice(0, 8)})`,
      discovery,
    )
  }
  externalPeerFoundCallback?.(peerInfo, discovery)
}

function handlePeerLost(peerId: string) {
  externalPeerLostCallback?.(peerId)
}

///////////////////////////////////////////////////////////////////////////////
// Public session API
///////////////////////////////////////////////////////////////////////////////
export async function start_session(
  on_message: MessageCallback,
  on_connected: ConnectionSuccessCallback,
  on_disconnect: DisconnectionCallback,
  on_peer_found: PeerFoundCallback,
  on_peer_lost: PeerLostCallback,
) {
  await initializeManager()
  if (isSessionActive) {
    console.log('[CM] Session already active.')
    return
  }

  externalMessageCallback = on_message
  externalConnectSuccessCallback = on_connected
  externalDisconnectCallback = on_disconnect
  externalPeerFoundCallback = on_peer_found
  externalPeerLostCallback = on_peer_lost

  if (Platform.OS === 'ios') {
    await Multipeer.startMultipeerSession(
      handleIncomingData,
      id => handleConnectionState(id, 'connected'),
      (id, reason) => {
        if (id)
          handleConnectionState(
            id,
            reason === 'failed' || reason === 'lost' ? 'failed' : 'disconnected',
          )
        else externalDisconnectCallback?.(null, reason ?? 'session_error')
      },
      handlePeerFound,
      handlePeerLost,
    )
  } else {
    console.log('[CM] Android session started – BLE discovery handled in UI.')
  }

  isSessionActive = true
}

export async function stop_session() {
  if (!isSessionActive) return
  isSessionActive = false

  try {
    if (Platform.OS === 'ios') await Multipeer.stopMultipeerSession()
    else await WebRTC.closeAllConnections()
  } finally {
    externalMessageCallback = null
    externalConnectSuccessCallback = null
    externalDisconnectCallback = null
    externalPeerFoundCallback = null
    externalPeerLostCallback = null
  }
}

export async function connect_to_device(targetPeerId: string) {
  await initializeManager()
  if (!targetPeerId) throw new Error('[CM] targetPeerId missing')

  if (Platform.OS === 'ios') {
    await Multipeer.invitePeer(targetPeerId)
  } else {
    if (targetPeerId === localPeerId)
      throw new Error('[CM] Cannot connect to self (WebRTC)')
    await WebRTC.initiateConnection(targetPeerId)
  }
}

///////////////////////////////////////////////////////////////////////////////
// Messaging helpers
///////////////////////////////////////////////////////////////////////////////
export async function send_message(message: string, peerId?: string) {
  if (!isManagerInitialized || !isSessionActive) return

  if (Platform.OS === 'ios') {
    await Multipeer.sendTextMessage(message, peerId ? [peerId] : undefined)
  } else {
    if (peerId) await WebRTC.sendData(peerId, message)
    else {
      const peers = WebRTC.getConnectedPeers()
      for (const p of peers) await WebRTC.sendData(p, message)
    }
  }
}

export async function send_audio_frame(
  pcm_base64: string,
  peerId?: string,
): Promise<void> {
  await send_message(`AUDIO:${pcm_base64}`, peerId)
}

///////////////////////////////////////////////////////////////////////////////
// Disconnection helpers
///////////////////////////////////////////////////////////////////////////////
export async function disconnect_peer(peerId: string) {
  if (!isManagerInitialized) return
  if (Platform.OS === 'ios') await Multipeer.disconnectAllPeers()
  else await WebRTC.closeConnection(peerId)
}

export async function disconnect_all_peers() {
  if (!isManagerInitialized) return
  if (Platform.OS === 'ios') await Multipeer.disconnectAllPeers()
  else await WebRTC.closeAllConnections()
}

export function getConnectedPeerIds(): string[] {
  if (!isManagerInitialized) return []
  return Platform.OS === 'ios'
    ? Multipeer.getConnectedPeerList()
    : WebRTC.getConnectedPeers()
}

///////////////////////////////////////////////////////////////////////////////
// Cleanup
///////////////////////////////////////////////////////////////////////////////
export async function cleanupManager() {
  if (isSessionActive) await stop_session().catch(console.warn)

  try {
    if (Platform.OS === 'ios') await Multipeer.cleanupMultipeer()
    else {
      await WebRTC.closeAllConnections()
      signalingEmitter.removeAllListeners()
    }
  } finally {
    localPeerId = null
    isManagerInitialized = false
    isSessionActive = false
  }
}

///////////////////////////////////////////////////////////////////////////////
// WebRTC-specific signaling hooks (Android / web)
///////////////////////////////////////////////////////////////////////////////
export function subscribeToSignalingSend(
  listener: (payload: { targetPeerId: string; message: any }) => void,
): () => void {
  if (Platform.OS === 'ios') return () => {}
  signalingEmitter.on(SIGNALING_EVENT_SEND, listener)
  return () => signalingEmitter.removeListener(SIGNALING_EVENT_SEND, listener)
}

export function receiveSignalingMessage(senderPeerId: string, message: any) {
  if (Platform.OS === 'ios' || !isManagerInitialized) return
  signalingEmitter.emit(SIGNALING_EVENT_RECEIVE, { senderPeerId, message })
}

function handleWebRTCSignalingSend(targetPeerId: string | null, message: any) {
  if (Platform.OS === 'ios' || !targetPeerId) return
  signalingEmitter.emit(SIGNALING_EVENT_SEND, { targetPeerId, message })
}

///////////////////////////////////////////////////////////////////////////////
// Getter
///////////////////////////////////////////////////////////////////////////////
export function getLocalPeerId(): string | null {
  return localPeerId
}
