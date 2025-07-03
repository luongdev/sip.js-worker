/**
 * Worker entry point
 */

import { MessageBroker } from './message-broker';
import { TabManager } from './tab-manager';
import { SipCore, SipCoreOptions } from './sip-core';
import { SipWorker, VERSION } from '../common/types';

// Khởi tạo MessageBroker
const messageBroker = new MessageBroker();

// Khởi tạo TabManager
const tabManager = new TabManager(messageBroker);

// Biến lưu trữ SipCore
let sipCore: SipCore | null = null;

// Cấu hình mặc định
const defaultConfig: SipCoreOptions = {
  sipConfig: {
    uri: '',
    username: '',
    password: '',
    displayName: '',
    registerExpires: 600
  },
  transportConfig: {
    server: '',
    secure: true,
    reconnectionTimeout: 5000,
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  },
  logConfig: {
    level: 'info',
    sendToClient: true,
    console: true
  },
  requestTimeout: 30000,
  autoRegister: false,
  autoAcceptCalls: false
};

// Xử lý kết nối mới từ các tab
self.addEventListener('connect', (event: any) => {
  const port = event.ports[0];
  
  // Bắt đầu lắng nghe tin nhắn từ port
  port.start();
  
  // Xử lý tin nhắn đầu tiên để lấy tabId từ client
  const handleFirstMessage = (messageEvent: MessageEvent) => {
    const message = messageEvent.data;
    
    // Lấy tabId từ tin nhắn đầu tiên
    const tabId = message.tabId;
    
    if (tabId) {
      // Đăng ký port với MessageBroker sử dụng tabId từ client
      messageBroker.registerTab(tabId, port);
      
      // Xóa listener tạm thời và chuyển sang xử lý bình thường
      port.removeEventListener('message', handleFirstMessage);
      
      // Thiết lập handler xử lý tin nhắn bình thường
      port.onmessage = (event: MessageEvent) => {
        messageBroker.processMessage(event.data, tabId, port);
      };
      
      // Xử lý tin nhắn đầu tiên này
      messageBroker.processMessage(message, tabId, port);
    } else {
      console.error('Tin nhắn đầu tiên không có tabId');
    }
  };
  
  // Thiết lập listener tạm thời cho tin nhắn đầu tiên
  port.addEventListener('message', handleFirstMessage);
});

// Đăng ký các handler xử lý tin nhắn
function registerMessageHandlers() {
  // Handler cho tin nhắn SIP_REGISTER
  messageBroker.on(SipWorker.MessageType.SIP_REGISTER, async (message, tabId, port) => {
    const data = message.data || {};
    
    if (!sipCore) {
      // Khởi tạo SipCore nếu chưa có
      const options: SipCoreOptions = {
        sipConfig: {
          ...defaultConfig.sipConfig,
          ...(data.sipConfig || {})
        },
        transportConfig: {
          ...defaultConfig.transportConfig,
          ...(data.transportConfig || {})
        },
        logConfig: defaultConfig.logConfig,
        requestTimeout: defaultConfig.requestTimeout,
        autoRegister: false, // Không tự động đăng ký, sẽ gọi register sau
        autoAcceptCalls: defaultConfig.autoAcceptCalls
      };
      
      sipCore = new SipCore(messageBroker, tabManager, options);
      
      // Đăng ký SIP
      return await sipCore.register();
    } else {
      // Nếu đã có SipCore, chỉ cần đăng ký lại với thông tin mới
      const credentials = data.sipConfig || {};
      return await sipCore.register(credentials);
    }
  });
  
  // Handler cho tin nhắn SIP_UNREGISTER
  messageBroker.on(SipWorker.MessageType.SIP_UNREGISTER, async (message, tabId, port) => {
    if (sipCore) {
      return await sipCore.unregister();
    }
    return { success: false, error: 'SIP not initialized' };
  });
  
  // Handler cho tin nhắn SIP_UPDATE_CREDENTIALS
  messageBroker.on(SipWorker.MessageType.SIP_UPDATE_CREDENTIALS, async (message, tabId, port) => {
    if (sipCore) {
      sipCore.updateCredentials(message.data || {});
      return { success: true };
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho tin nhắn CALL_MAKE
  messageBroker.on(SipWorker.MessageType.CALL_MAKE, async (message, tabId, port) => {
    if (sipCore) {
      const request = message.data as SipWorker.MakeCallRequest;
      return await sipCore.makeCall(request);
    }
    return { success: false, error: 'SIP not initialized' };
  });
  
  // Handler cho tin nhắn PING
  messageBroker.on(SipWorker.MessageType.PING, async (message, tabId, port) => {
    return {
      success: true,
      timestamp: Date.now(),
      type: SipWorker.MessageType.PONG
    };
  });
}

// Khởi tạo worker
function initWorker() {
  // Đăng ký các handler xử lý tin nhắn
  registerMessageHandlers();
  
  // Thông báo worker đã sẵn sàng
  messageBroker.broadcast({
    type: SipWorker.MessageType.WORKER_READY,
    id: `worker-ready-${Date.now()}`,
    timestamp: Date.now(),
    data: {
      version: VERSION
    }
  });
  
  // Log
  console.log('SIP Worker initialized successfully');
}

// Khởi tạo worker
initWorker(); 