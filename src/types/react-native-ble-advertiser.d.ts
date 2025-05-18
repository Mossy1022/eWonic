// src/types/react-native-ble-advertiser.d.ts

declare module 'react-native-ble-advertiser' {

    // Define the structure for advertising options
    export interface BroadcastOptions {
      deviceName?: string;         // The name to advertise
      includeDeviceName?: boolean;   // Whether to include the device name
      includeTxPowerLevel?: boolean; // Whether to include transmission power
      manufacturerData?: number[];  // Array of bytes for manufacturer data
      serviceData?: number[];       // Array of bytes for service data
      connectable?: boolean;        // Whether the advertisement is connectable
    }
  
    // Define the interface for the module
    interface BleAdvertiserModule {
      /**
       * Sets the company identifier for Manufacturer Data.
       * @param id Company ID (e.g., 0xFFFF for testing)
       */
      setCompanyId(id: number): void;
  
      /**
       * Starts broadcasting an advertisement packet.
       * @param serviceUUID The primary service UUID to advertise.
       * @param manufacturerData Array of bytes for manufacturer data (often empty).
       * @param options Configuration for the advertisement packet.
       */
      broadcast(serviceUUID: string, manufacturerData: number[], options: BroadcastOptions): Promise<string>; // Promise might resolve with success/status string
  
      /**
       * Stops broadcasting.
       */
      stopBroadcast(): Promise<string>; // Promise might resolve with success/status string
  
      // Add other methods if you use them (e.g., related to status checks)
    }
  
    const BleAdvertiser: BleAdvertiserModule;
  
    export default BleAdvertiser;
  }