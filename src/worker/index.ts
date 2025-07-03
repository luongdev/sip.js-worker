import { MessageBroker } from './message-broker';
import { TabManager } from './tab-manager';
import { MessageType, TabState, Message } from '../common/types';

// Khởi tạo các đối tượng chính
const messageBroker = new MessageBroker();
const tabManager = new TabManager();

// Thiết lập các handler cho các loại tin nhắn
setupMessageHandlers();

// Thiết lập interval để kiểm tra các tab không hoạt động
setupTabTimeoutCheck();

// Xử lý kết nối mới từ các tab
self.addEventListener('connect', (event: MessageEvent) => {
  const port = (event as any).ports[0];
  
  // Đăng ký port với message broker
  messageBroker.registerPort(port);
  
  // Log kết nối mới
  console.log('New connection established');
});

// Thiết lập các handler xử lý tin nhắn
function setupMessageHandlers() {
  // Handler đăng ký tab mới
  messageBroker.registerHandler(MessageType.REGISTER_TAB, (message: Message) => {
    const { tabId, data } = message;
    
    if (!tabId) {
      console.error('Missing tabId in REGISTER_TAB message');
      return;
    }
    
    // Đăng ký tab mới với TabManager
    tabManager.registerTab(tabId, {
      state: data.state || TabState.ACTIVE,
      lastActive: Date.now(),
      url: data.url || '',
      title: data.title || ''
    });
    
    // Gửi danh sách tab hiện tại cho tất cả các tab
    broadcastTabList();
    
    console.log(`Tab registered: ${tabId}`);
  });
  
  // Handler cập nhật trạng thái tab
  messageBroker.registerHandler(MessageType.UPDATE_TAB_STATE, (message: Message) => {
    const { tabId, data } = message;
    
    if (!tabId || !data.state) {
      console.error('Missing tabId or state in UPDATE_TAB_STATE message');
      return;
    }
    
    // Cập nhật trạng thái tab
    tabManager.updateTabState(tabId, data.state);
    
    // Gửi danh sách tab hiện tại cho tất cả các tab
    broadcastTabList();
    
    console.log(`Tab state updated: ${tabId} -> ${data.state}`);
  });
  
  // Handler hủy đăng ký tab (khi tab đóng)
  messageBroker.registerHandler(MessageType.UNREGISTER_TAB, (message: Message) => {
    const { tabId } = message;
    
    if (!tabId) {
      console.error('Missing tabId in UNREGISTER_TAB message');
      return;
    }
    
    // Xóa tab khỏi TabManager
    tabManager.removeTab(tabId);
    
    // Gửi danh sách tab hiện tại cho tất cả các tab
    broadcastTabList();
    
    console.log(`Tab unregistered: ${tabId}`);
  });
  
  // Handler cho tin nhắn PING
  messageBroker.registerHandler(MessageType.PING, (message: Message) => {
    const { tabId } = message;
    
    if (!tabId) {
      console.error('Missing tabId in PING message');
      return;
    }
    
    // Cập nhật thời gian hoạt động cuối cùng của tab
    tabManager.updateLastActive(tabId);
    
    // Gửi PONG về cho tab
    messageBroker.sendMessageToTab(tabId, {
      type: MessageType.PONG,
      tabId: 'worker',
      data: { timestamp: Date.now() }
    });
    
    console.log(`Ping received from tab: ${tabId}`);
  });
  
  // Handler cho tin nhắn PONG
  messageBroker.registerHandler(MessageType.PONG, (message: Message) => {
    const { tabId } = message;
    
    if (!tabId) {
      console.error('Missing tabId in PONG message');
      return;
    }
    
    // Cập nhật thời gian hoạt động cuối cùng của tab
    tabManager.updateLastActive(tabId);
    
    console.log(`Pong received from tab: ${tabId}`);
  });
  
  // Handler cho tin nhắn TAB_TIMEOUT (giả lập timeout)
  messageBroker.registerHandler(MessageType.TAB_TIMEOUT, (message: Message) => {
    const { tabId } = message;
    
    if (!tabId) {
      console.error('Missing tabId in TAB_TIMEOUT message');
      return;
    }
    
    // Kiểm tra xem tab có tồn tại không
    if (tabManager.hasTab(tabId)) {
      // Cập nhật trạng thái tab thành INACTIVE
      tabManager.updateTabState(tabId, TabState.INACTIVE);
      
      // Gửi danh sách tab hiện tại cho tất cả các tab
      broadcastTabList();
      
      console.log(`Tab timeout simulated: ${tabId}`);
    } else {
      console.error(`Tab not found: ${tabId}`);
    }
  });
  
  // Handler mặc định cho các loại tin nhắn khác
  messageBroker.registerHandler(MessageType.CUSTOM, (message: Message) => {
    const { tabId, targetTabId, data } = message;
    
    console.log(`Custom message from ${tabId}:`, data);
    
    // Nếu có targetTabId, gửi tin nhắn đến tab đó
    if (targetTabId) {
      messageBroker.sendMessageToTab(targetTabId, {
        type: MessageType.CUSTOM,
        tabId: tabId,
        data: data
      });
    } else {
      // Nếu không có targetTabId, broadcast tin nhắn đến tất cả các tab
      messageBroker.broadcastMessage({
        type: MessageType.CUSTOM,
        tabId: tabId,
        data: data
      });
    }
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
    Object.entries(tabs).forEach(([tabId, tabInfo]) => {
      // Nếu tab không hoạt động trong 30 giây, đánh dấu là INACTIVE
      if (now - tabInfo.lastActive > TAB_TIMEOUT && tabInfo.state !== TabState.INACTIVE) {
        tabManager.updateTabState(tabId, TabState.INACTIVE);
        hasChanges = true;
        console.log(`Tab marked as inactive due to timeout: ${tabId}`);
      }
    });
    
    // Nếu có sự thay đổi, gửi danh sách tab mới
    if (hasChanges) {
      broadcastTabList();
    }
    
    // Gửi PING đến tất cả các tab để kiểm tra kết nối
    messageBroker.broadcastMessage({
      type: MessageType.PING,
      tabId: 'worker',
      data: { timestamp: now }
    });
    
  }, TIMEOUT_INTERVAL);
}

// Gửi danh sách tab hiện tại đến tất cả các tab
function broadcastTabList() {
  const tabs = tabManager.getAllTabs();
  
  messageBroker.broadcastMessage({
    type: MessageType.TAB_LIST_UPDATE,
    tabId: 'worker',
    data: { tabs }
  });
}

// Log khởi động worker
console.log('Worker started'); 