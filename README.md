# SIP.js Worker

A SIP client library using Web Worker architecture to handle SIP signaling separately from the UI thread. Supports multiple tabs sharing a single SIP session.

## Features

- ✅ **Multi-tab Support**: Multiple tabs can share a single SIP session
- ✅ **Web Worker Architecture**: SIP signaling runs in SharedWorker
- ✅ **WebRTC Media**: Handle audio/video calls with WebRTC
- ✅ **Call Control**: Hold/unhold, mute/unmute, call transfer
- ✅ **DTMF Support**: Send DTMF tones during calls
- ✅ **Tab Coordination**: Automatically select tab to handle media
- ✅ **State Synchronization**: Synchronize state between tabs

## Installation

```bash
npm install sip-worker.js
```

## Build

```bash
# Build client library
npm run build

# Build worker
npm run build:worker

# Build both
npm run build:all
```

## Basic Usage

### 1. Initialize Client

```typescript
import { SipWorkerClient } from 'sip-worker.js';

const sipClient = new SipWorkerClient();
```

### 2. SIP Registration

```typescript
sipClient.register({
  uri: 'sip:username@domain.com',
  username: 'username',
  password: 'password',
  displayName: 'Display Name'
}, {
  server: 'wss://domain.com:443',
  secure: true
});
```

### 3. Event Listeners

```typescript
sipClient.on('sip_registered', () => {
  console.log('SIP registered successfully');
});

sipClient.on('call_incoming', (message) => {
  const callInfo = message.data;
  console.log(`Incoming call from: ${callInfo.remoteUri}`);
  
  // Accept call
  sipClient.answerCall(callInfo.id);
  
  // Or reject
  // sipClient.rejectCall(callInfo.id);
});

sipClient.on('call_progress', (message) => {
  const callInfo = message.data;
  console.log(`Call state: ${callInfo.state}`);
});
```

### 4. Make Calls

```typescript
sipClient.makeCall('sip:target@domain.com');
```

### 5. Call Control

```typescript
// Mute/unmute
sipClient.muteCall(callId);
sipClient.unmuteCall(callId);

// Hold/unhold
sipClient.holdCall(callId);
sipClient.unholdCall(callId);

// DTMF
sipClient.sendDtmf(callId, '123');

// Transfer
sipClient.transferCall(callId, 'sip:target@domain.com', 'blind');
```

## Architecture

### Worker Side
- **SipCore**: Handle SIP signaling with SIP.js
- **TabManager**: Manage tabs and select tab for media handling
- **MessageBroker**: Handle messaging between worker and tabs
- **WorkerSessionDescriptionHandler**: Custom SDP handler for worker

### Client Side  
- **SipWorkerClient**: Main client API
- **MediaHandler**: Handle WebRTC media, getUserMedia, ICE

### Message Flow
```
Tab A ←→ MessageBroker ←→ SipCore ←→ SIP Server
Tab B ←→      ↑
Tab C ←→ TabManager
```

## Demo

Open `index.html` in browser to see full demo with:
- SIP registration
- Incoming/outgoing calls  
- Call controls (hold, mute, transfer)
- DTMF keypad
- Multi-tab coordination

Or run dev server:

```bash
npm run dev
```

## Configuration Options

### SipConfig
```typescript
interface SipConfig {
  uri: string;           // SIP URI
  username?: string;     // Username
  password?: string;     // Password  
  displayName?: string;  // Display name
  registerExpires?: number; // Registration expiry (seconds)
}
```

### TransportConfig
```typescript
interface TransportConfig {
  server: string;        // WebSocket server URL
  secure?: boolean;      // Use TLS
  iceServers?: IceServer[]; // STUN/TURN servers
}
```

## Events

| Event | Description |
|-------|-------------|
| `worker_ready` | Worker is ready |
| `sip_registered` | SIP registration successful |
| `sip_unregistered` | SIP unregistered |
| `sip_registration_failed` | SIP registration failed |
| `call_incoming` | Incoming call |
| `call_progress` | Call progress |
| `call_terminated` | Call terminated |
| `call_muted` | Call muted |
| `call_held` | Call held |

## Browser Support

- Chrome/Chromium 80+
- Firefox 74+  
- Safari 13+
- Edge 80+

## License

This project is licensed under a Custom License. See [LICENSE](LICENSE) file for details.

### Commercial Usage

- **Free for Omicx**: This software is free to use for the Omicx product (https://omicx.vn)
- **Other Commercial Use**: For all other commercial applications, please contact luongld.it@gmail.com for licensing terms

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

For support and questions:
- Email: luongld.it@gmail.com
- Issues: [GitHub Issues](https://github.com/your-repo/issues) 