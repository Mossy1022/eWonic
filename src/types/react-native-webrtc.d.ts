// src/types/react-native-webrtc.d.ts

import { RTCPeerConnection, RTCIceCandidate, RTCDataChannelState, RTCIceConnectionState, RTCSignalingState } from 'react-native-webrtc';

// Define the expected event types based on WebRTC standards
// Use 'any' if the exact event structure from the library isn't known
interface RTCPeerConnectionIceEvent {
    candidate: RTCIceCandidate | null;
    // url?: string; // Older versions might have included url
}

interface RTCDataChannelEvent {
    channel: any; // The data channel instance
}

// Define a base Event type if not globally available in your TS setup
// interface Event {
//     readonly type: string;
//     // other common Event properties
// }

interface RTCErrorEvent extends Event {
    readonly error: any; // Or a more specific error type if known
}

interface MessageEvent {
    readonly data: any; // Can be string, Blob, ArrayBuffer, etc.
    // other MessageEvent properties
}


// Augment the existing module declaration
declare module 'react-native-webrtc' {

    // Add the missing event handler properties to RTCPeerConnection
    interface RTCPeerConnection {
        onicecandidate: ((event: RTCPeerConnectionIceEvent | null) => void) | null;
        oniceconnectionstatechange: (() => void) | null;
        ondatachannel: ((event: RTCDataChannelEvent) => void) | null;
        onsignalingstatechange: (() => void) | null;
        // Add other missing handlers if needed, e.g., ontrack, onnegotiationneeded
    }

    // Augment the RTCDataChannel type if its handlers are also missing/incorrect
    // Note: RTCDataChannel might not be explicitly exported, so we might need to define
    // its expected interface or use 'any' for the channel object.
    // Let's assume for now the channel object obtained has these methods/properties:
    interface RTCDataChannel { // Assuming 'any' was used previously for the channel object
        onopen: (() => void) | null;
        onclose: (() => void) | null;
        onerror: ((event: RTCErrorEvent) => void) | null; // Use RTCErrorEvent if defined, else 'any' or generic Error
        onmessage: ((event: MessageEvent) => void) | null;
        readyState: RTCDataChannelState;
        label: string;
        send(data: string | Blob | ArrayBuffer | ArrayBufferView): void;
        close(): void;
        // Add other RTCDataChannel properties/methods if needed
    }
}

// Ensure this file is treated as a module by adding an empty export
export {};