/**
 * @fileoverview Integration test to verify BLE scanning + P2P connection logic.
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { BleManager } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import LobbyScreen from '../../screens/LobbyScreen';

jest.mock('react-native-ble-plx', () => ({
  BleManager: jest.fn().mockImplementation(() => ({
    startDeviceScan: jest.fn((_uuids, _opts, listener) => {
      listener(null, { id: 'FAKE_DEVICE_ID', name: 'Mocked BLE Device' });
    }),
    stopDeviceScan: jest.fn(),
    connectToDevice: jest.fn(),
  })),
}));

jest.mock('react-native-wifi-p2p', () => ({
  initialize: jest.fn(async () => Promise.resolve()),
  connect: jest.fn(async () => Promise.resolve()),
  isWifiP2pEnabled: jest.fn(async () => true),
  enable: jest.fn(async () => Promise.resolve()),
  sendMessage: jest.fn(async () => Promise.resolve()),
  subscribeOnEvent: jest.fn((event, cb) => {
    if (event === 'connectionInfo') {
      cb({ groupFormed: true });
    } else if (event === 'dataReceived') {
      cb({ message: 'Mocked data message' });
    }
  }),
}));

jest.mock('react-native-multipeer', () => ({
  start: jest.fn(async () => Promise.resolve()),
  invite: jest.fn(async () => Promise.resolve()),
  send: jest.fn(async () => Promise.resolve()),
  on: jest.fn((event, cb) => {
    if (event === 'peerFound') {
      cb({ id: 'FAKE_DEVICE_ID' });
    }
  }),
}));

describe('BLE + P2P Integration Test', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform });
  });

  const setPlatform = (os: 'android' | 'ios') => {
    Object.defineProperty(Platform, 'OS', { value: os });
  };

  it('should discover mock BLE device and trigger WifiP2p connect on Android', async () => {
    setPlatform('android');

    const { getByText, queryByText } = render(<LobbyScreen />);

    fireEvent.press(getByText('START BLE DISCOVERY'));

    await waitFor(() =>
      expect(queryByText('Mocked BLE Device - FAKE_DEVICE_ID')).toBeTruthy()
    );

    await act(async () => {
      fireEvent.press(getByText('Connect'));
    });

    const wifiP2p = require('react-native-wifi-p2p');
    expect(wifiP2p.initialize).toHaveBeenCalled();
    expect(wifiP2p.connect).toHaveBeenCalledWith('FAKE_DEVICE_ID');
  });

  it('should discover mock BLE device and trigger Multipeer invite on iOS', async () => {
    setPlatform('ios');

    const { getByText, queryByText } = render(<LobbyScreen />);

    fireEvent.press(getByText('Start BLE Discovery')); // Corrected casing

    await waitFor(() =>
      expect(queryByText('Mocked BLE Device - FAKE_DEVICE_ID')).toBeTruthy()
    );

    await act(async () => {
      fireEvent.press(getByText('Connect'));
    });

    const multipeer = require('react-native-multipeer');
    expect(multipeer.start).toHaveBeenCalledWith('ewonic-lobby');
    expect(multipeer.invite).toHaveBeenCalledWith('FAKE_DEVICE_ID');
    expect(multipeer.send).toHaveBeenCalled();
  });
});
