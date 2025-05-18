/**
 * Configuration constants for BLE operations.
 */

// Prefix for the advertised local name to identify eWonic devices.
export const EWONIC_BLE_PREFIX = 'EWONIC:';

// Service Type for Multipeer Connectivity (iOS P2P - kept for reference, but unused for WebRTC)
export const EWONIC_MULTIPEER_SERVICE_TYPE = 'ewonic-p2p'; // Must be 1-15 chars, alphanumeric and hyphens

// --- BLE GATT Service/Characteristic for WebRTC Signaling ---
// Use `uuidgen` or an online tool to create unique UUIDs.
// Ensure these are identical across all app instances.

// The primary service UUID used for advertising discovery AND containing the signaling characteristic.
export const EWONIC_SIGNALING_SERVICE_UUID = "46cebde2-a167-4543-ae9d-b468f628fe45"; // Keep your existing one if preferred

// The characteristic UUID used within the EWONIC_SIGNALING_SERVICE_UUID for exchanging SDP/ICE messages.
export const EWONIC_SIGNALING_CHARACTERISTIC_UUID = "46cebde3-a167-4543-ae9d-b468f628fe45"; // ** NEW UUID **

// --- Optional: Manufacturer Data ID (if using ManufacturerData advertising) ---
// Use a registered Company ID if applicable, or 0xFFFF for testing.
export const EWONIC_MANUFACTURER_ID = 0xFFFF; // Example ID
