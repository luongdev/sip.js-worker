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
  
  // Tạo ID cho tab mới
  const tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  
  // Đăng ký port với MessageBroker
  messageBroker.registerTab(tabId, port);
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
  
  // Handler cho tin nhắn TAB_REGISTER
  messageBroker.on(SipWorker.MessageType.TAB_REGISTER, async (message, tabId, port) => {
    if (!message.data) {
      return { success: false, error: 'No tab data provided' };
    }
    
    const tabInfo: SipWorker.TabInfo = {
      ...message.data,
      port: port
    };
    
    tabManager.registerTab(tabInfo);
    return { success: true };
  });
  
  // Handler cho tin nhắn TAB_UNREGISTER
  messageBroker.on(SipWorker.MessageType.TAB_UNREGISTER, async (message, tabId, port) => {
    if (!message.tabId) {
      return { success: false, error: 'No tab ID provided' };
    }
    
    tabManager.unregisterTab(message.tabId);
    return { success: true };
  });
  
  // Handler cho tin nhắn TAB_UPDATE_STATE
  messageBroker.on(SipWorker.MessageType.TAB_UPDATE_STATE, async (message, tabId, port) => {
    if (!message.tabId || !message.data) {
      return { success: false, error: 'Invalid tab update data' };
    }
    
    tabManager.updateTabState(message.tabId, message.data);
    return { success: true };
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