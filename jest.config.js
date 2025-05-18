// eWonic/jest.config.js
module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['@testing-library/jest-native/extend-expect'],
  transformIgnorePatterns: [
    'node_modules/(?!react-native|@react-native|@react-navigation|react-native-ble-plx|react-native-wifi-p2p|react-native-multipeer)',
  ],
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
};
