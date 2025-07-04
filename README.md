# SIP.js Worker

Thư viện SIP client sử dụng Web Worker architecture để xử lý SIP signaling riêng biệt khỏi UI thread. Hỗ trợ multiple tabs cùng chia sẻ một SIP session.

## Tính năng

- ✅ **Multi-tab Support**: Nhiều tab có thể cùng chia sẻ một SIP session
- ✅ **Web Worker Architecture**: SIP signaling chạy trong SharedWorker
- ✅ **WebRTC Media**: Xử lý audio/video calls với WebRTC
- ✅ **Call Control**: Hold/unhold, mute/unmute, call transfer
- ✅ **DTMF Support**: Gửi DTMF tones trong cuộc gọi
- ✅ **Tab Coordination**: Tự động chọn tab để xử lý media
- ✅ **State Synchronization**: Đồng bộ trạng thái giữa các tabs

## Cài đặt

```bash
npm install
```

## Build

```bash
# Build client library
npm run build

# Build worker
npm run build:worker

# Build cả hai
npm run build:all
```

## Sử dụng cơ bản

### 1. Khởi tạo Client

```typescript
import { SipWorkerClient } from 'sip-worker.js';

const sipClient = new SipWorkerClient();
```

### 2. Đăng ký SIP

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

### 3. Lắng nghe events

```typescript
sipClient.on('sip_registered', () => {
  console.log('SIP registered successfully');
});

sipClient.on('call_incoming', (message) => {
  const callInfo = message.data;
  console.log(`Incoming call from: ${callInfo.remoteUri}`);
  
  // Chấp nhận cuộc gọi
  sipClient.answerCall(callInfo.id);
  
  // Hoặc từ chối
  // sipClient.rejectCall(callInfo.id);
});

sipClient.on('call_progress', (message) => {
  const callInfo = message.data;
  console.log(`Call state: ${callInfo.state}`);
});
```

### 4. Thực hiện cuộc gọi

```typescript
sipClient.makeCall('sip:target@domain.com');
```

### 5. Điều khiển cuộc gọi

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
- **SipCore**: Xử lý SIP signaling với SIP.js
- **TabManager**: Quản lý các tabs và chọn tab xử lý media
- **MessageBroker**: Xử lý messaging giữa worker và tabs
- **WorkerSessionDescriptionHandler**: Custom SDP handler cho worker

### Client Side  
- **SipWorkerClient**: Main client API
- **MediaHandler**: Xử lý WebRTC media, getUserMedia, ICE

### Message Flow
```
Tab A ←→ MessageBroker ←→ SipCore ←→ SIP Server
Tab B ←→      ↑
Tab C ←→ TabManager
```

## Demo

Mở `index.html` trong browser để xem demo đầy đủ với:
- SIP registration
- Incoming/outgoing calls  
- Call controls (hold, mute, transfer)
- DTMF keypad
- Multi-tab coordination

Hoặc chạy dev server:

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
| `worker_ready` | Worker đã sẵn sàng |
| `sip_registered` | Đăng ký SIP thành công |
| `sip_unregistered` | Hủy đăng ký SIP |
| `sip_registration_failed` | Đăng ký SIP thất bại |
| `call_incoming` | Có cuộc gọi đến |
| `call_progress` | Tiến trình cuộc gọi |
| `call_terminated` | Cuộc gọi kết thúc |
| `call_muted` | Cuộc gọi đã mute |
| `call_held` | Cuộc gọi đã hold |

## Browser Support

- Chrome/Chromium 80+
- Firefox 74+  
- Safari 13+
- Edge 80+

## License

MIT 