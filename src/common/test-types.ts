/**
 * File kiểm tra import types từ common/types.ts
 */

import { VERSION, SipWorker } from './types';

// Kiểm tra phiên bản
console.log('SIP Worker version =', VERSION);

// Kiểm tra enum MessageType
const messageType: SipWorker.MessageType = SipWorker.MessageType.TAB_REGISTER;
console.log('MessageType.TAB_REGISTER =', messageType);

// Kiểm tra interface Message
const message: SipWorker.Message = {
  type: SipWorker.MessageType.TAB_REGISTER,
  id: '123',
  timestamp: Date.now(),
  data: { hello: 'world' }
};
console.log('Message =', message);

// Kiểm tra enum TabState
const tabState: SipWorker.TabState = SipWorker.TabState.ACTIVE;
console.log('TabState.ACTIVE =', tabState);

// Kiểm tra enum TabMediaPermission
const tabMediaPermission: SipWorker.TabMediaPermission = SipWorker.TabMediaPermission.GRANTED;
console.log('TabMediaPermission.GRANTED =', tabMediaPermission);

// Kiểm tra interface TabInfo
const tabInfo: SipWorker.TabInfo = {
  id: '123',
  name: 'Test Tab',
  url: 'https://example.com',
  state: SipWorker.TabState.ACTIVE,
  lastActiveTime: Date.now(),
  createdTime: Date.now(),
  mediaPermission: SipWorker.TabMediaPermission.GRANTED,
  handlingCall: false
};
console.log('TabInfo =', tabInfo);

// Kiểm tra interface SipConfig
const sipConfig: SipWorker.SipConfig = {
  uri: 'sip:user@example.com',
  username: 'user',
  password: 'password',
  displayName: 'Test User',
  registerExpires: 3600,
  extraHeaders: {
    'X-Custom-Header': 'Custom Value'
  },
  sipOptions: {
    userAgentString: 'SIP Worker Test'
  }
};
console.log('SipConfig =', sipConfig);

// Kiểm tra interface IceServer
const iceServer: SipWorker.IceServer = {
  urls: 'stun:stun.l.google.com:19302',
  username: 'testuser',
  credential: 'testpassword'
};
console.log('IceServer =', iceServer);

// Kiểm tra interface TransportConfig với iceServers
const transportConfig: SipWorker.TransportConfig = {
  server: 'wss://sip.example.com',
  secure: true,
  reconnectionTimeout: 5000,
  maxReconnectionAttempts: 3,
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:turn.example.com:3478',
      username: 'turnuser',
      credential: 'turnpassword'
    }
  ]
};
console.log('TransportConfig =', transportConfig);

// Kiểm tra interface LogConfig
const logConfig: SipWorker.LogConfig = {
  level: 'debug',
  sendToClient: true,
  console: true
};
console.log('LogConfig =', logConfig);

// Kiểm tra interface WorkerConfig
const workerConfig: SipWorker.WorkerConfig = {
  sip: sipConfig,
  transport: transportConfig,
  log: logConfig,
  requestTimeout: 30000,
  autoRegister: true,
  autoAcceptCalls: false,
  tabSelectionTimeout: 5000
};
console.log('WorkerConfig =', workerConfig);

// Kiểm tra interface MediaConfig chỉ với audio
const mediaConfig: SipWorker.MediaConfig = {
  audio: {
    enabled: true,
    constraints: {
      echoCancellation: true,
      noiseSuppression: true
    },
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    autoGainControl: true,
    noiseSuppression: true,
    echoCancellation: true
  },
  autoRequestPermissions: true,
  autoShowPermissionDialog: true
};
console.log('MediaConfig =', mediaConfig);

// Kiểm tra interface UIConfig
const uiConfig: SipWorker.UIConfig = {
  notifications: {
    incomingCall: true,
    registered: true,
    registrationFailed: true,
    error: true
  },
  sounds: {
    incomingCall: true,
    outgoingCall: true,
    callEnded: true
  },
  soundFiles: {
    incomingCall: 'sounds/incoming.mp3',
    outgoingCall: 'sounds/outgoing.mp3',
    callEnded: 'sounds/ended.mp3'
  }
};
console.log('UIConfig =', uiConfig);

// Kiểm tra interface ClientConfig
const clientConfig: SipWorker.ClientConfig = {
  workerPath: '/worker.js',
  media: mediaConfig,
  ui: uiConfig,
  autoConnect: true,
  autoRegisterTab: true,
  autoUpdateTabState: true,
  requestTimeout: 30000,
  tabId: '123',
  tabName: 'Test Tab'
};
console.log('ClientConfig =', clientConfig);

console.log('Tất cả các test đã chạy thành công!'); 