/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './src/App';
import {name as appName} from './app.json';

import { encode, decode } from 'base-64';
import { Buffer } from 'buffer';

if (!global.atob)  global.atob  = decode;
if (!global.btoa)  global.btoa  = encode;
global.Buffer = Buffer;

AppRegistry.registerComponent(appName, () => App);
