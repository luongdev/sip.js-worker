import { MessageBroker } from './message-broker';
import { TabManager } from './tab-manager';
import { SipWorker } from '../common/types';

// Khởi tạo các đối tượng chính
const messageBroker = new MessageBroker();
const tabManager = new TabManager(messageBroker);

// Thiết lập các handler cho các loại tin nhắn
setupMessageHandlers();

// Thiết lập interval để kiểm tra các tab không hoạt động
setupTabTimeoutCheck();

// Xử lý kết nối mới từ các tab
self.addEventListener('connect', (event: any) => {
  const port = event.ports[0];
  
  // Đăng ký port với message broker để nhận tin nhắn từ tab
  const tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  messageBroker.registerTab(tabId, port);
  
  // Log kết nối mới
  console.log('New connection established with tabId:', tabId);
});

// Thiết lập các handler xử lý tin nhắn
function setupMessageHandlers() {
  // Handler đăng ký tab mới - đã được xử lý trong TabManager
  
  // Handler cho tin nhắn ping để kiểm tra kết nối
  messageBroker.on(SipWorker.MessageType.PING, async (message, tabId) => {
    console.log(`Ping received from tab ${tabId}`);
    
    // Gửi pong về cho tab
    await messageBroker.sendToTab(tabId, {
      type: SipWorker.MessageType.PONG,
      id: `pong-${message.id}`,
      timestamp: Date.now(),
      data: { timestamp: Date.now() }
    });
    
    return { success: true };
  });
  
  // Handler cho tin nhắn pong
  messageBroker.on(SipWorker.MessageType.PONG, async (message, tabId) => {
    console.log(`Pong received from tab ${tabId}`);
    return { success: true };
  });
  
  // Handler cho tin nhắn tab_register
  messageBroker.on(SipWorker.MessageType.TAB_REGISTER, async (message, tabId) => {
    console.log(`Tab register message from tab ${tabId}`, message.data);
    
    // Đăng ký tab với TabManager
    const tabInfo = tabManager.registerTab(tabId, message.data);
    
    // Broadcast danh sách tab mới
    broadcastTabList();
    
    return { success: true, tabInfo };
  });
  
  // Handler cho tin nhắn tab_update_state
  messageBroker.on(SipWorker.MessageType.TAB_UPDATE_STATE, async (message, tabId) => {
    console.log(`Tab update state message from tab ${tabId}`, message.data);
    
    if (!message.data || !message.data.state) {
      return { success: false, error: 'Missing state in message data' };
    }
    
    // Cập nhật trạng thái tab
    const tabInfo = tabManager.updateTabState(tabId, message.data.state);
    
    // Broadcast danh sách tab mới
    broadcastTabList();
    
    return { success: true, tabInfo };
  });
  
  // Handler cho tin nhắn tab_unregister
  messageBroker.on(SipWorker.MessageType.TAB_UNREGISTER, async (message, tabId) => {
    console.log(`Tab unregister message from tab ${tabId}`);
    
    // Hủy đăng ký tab
    tabManager.unregisterTab(tabId);
    
    // Broadcast danh sách tab mới
    broadcastTabList();
    
    return { success: true };
  });
  
  // Thêm handler cho tin nhắn WORKER_READY để thông báo worker đã sẵn sàng
  messageBroker.on(SipWorker.MessageType.WORKER_READY, async (message, tabId) => {
    console.log(`Worker ready message from tab ${tabId}`);
    return { success: true };
  });
  
  // Handler cho tin nhắn ERROR để ghi log lỗi
  messageBroker.on(SipWorker.MessageType.ERROR, async (message, tabId) => {
    console.error(`Error from tab ${tabId}:`, message.data);
    return { success: true };
  });
  
  // Handler cho tin nhắn LOG để ghi log
  messageBroker.on(SipWorker.MessageType.LOG, async (message, tabId) => {
    console.log(`Log from tab ${tabId}:`, message.data);
    return { success: true };
  });
}

// Thiết lập kiểm tra tab timeout
function setupTabTimeoutCheck() {
  const TIMEOUT_INTERVAL = 10000; // 10 giây
  const TAB_TIMEOUT = 30000; // 30 giây
  
  setInterval(() => {
    const now = Date.now();
    const tabs = tabManager.getAllTabs();
    let hasChanges = false;
    
    // Kiểm tra từng tab
    tabs.forEach((tabInfo) => {
      // Nếu tab không hoạt động trong 30 giây, đánh dấu là HIDDEN
      if (now - tabInfo.lastActiveTime > TAB_TIMEOUT && 
          tabInfo.state !== SipWorker.TabState.HIDDEN) {
        tabManager.updateTabState(tabInfo.id, SipWorker.TabState.HIDDEN);
        hasChanges = true;
        console.log(`Tab marked as hidden due to timeout: ${tabInfo.id}`);
      }
    });
    
    // Nếu có sự thay đổi, gửi danh sách tab mới
    if (hasChanges) {
      broadcastTabList();
    }
    
    // Gửi ping định kỳ đến tất cả các tab để kiểm tra kết nối
    pingAllTabs();
    
  }, TIMEOUT_INTERVAL);
}

// Gửi ping đến tất cả các tab
function pingAllTabs() {
  messageBroker.broadcast({
    type: SipWorker.MessageType.PING,
    id: `ping-${Date.now()}`,
    timestamp: Date.now(),
    data: { timestamp: Date.now() }
  });
}

// Gửi danh sách tab hiện tại đến tất cả các tab
function broadcastTabList() {
  const tabs = tabManager.getAllTabs();
  
  // Tạo bản sao của danh sách tab mà không có trường port
  const tabsForBroadcast = tabs.map(tab => {
    // Tạo bản sao không có trường port
    const { port, ...tabWithoutPort } = tab;
    return tabWithoutPort;
  });
  
  messageBroker.broadcast({
    type: SipWorker.MessageType.TAB_LIST_UPDATE,
    id: `tab-list-update-${Date.now()}`,
    timestamp: Date.now(),
    data: { tabs: tabsForBroadcast }
  });
}

// Thêm hàm để broadcast danh sách tab định kỳ
setInterval(() => {
  broadcastTabList();
}, 5000); // Mỗi 5 giây

// Log khởi động worker
console.log('Worker started'); 