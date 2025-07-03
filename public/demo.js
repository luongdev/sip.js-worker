import { SipWorker } from '../src/common/types';

// Các biến toàn cục
let worker = null;
let tabId = generateTabId();
let allTabs = {};
let messageHistory = [];

// Khởi tạo worker và thiết lập các sự kiện
function initializeWorker() {
  try {
    worker = new SharedWorker('/src/worker/index.ts', { type: 'module' });
    
    worker.port.onmessage = (event) => {
      const message = event.data;
      log(`Received message: ${JSON.stringify(message)}`);
      
      // Thêm tin nhắn vào lịch sử
      messageHistory.push({
        direction: 'received',
        message: message,
        timestamp: new Date()
      });
      updateMessageList();
      
      // Xử lý tin nhắn dựa trên loại
      handleMessage(message);
    };
    
    worker.port.onmessageerror = (error) => {
      log(`Worker message error: ${error}`, 'error');
    };
    
    worker.onerror = (error) => {
      log(`Worker error: ${error.message}`, 'error');
      updateWorkerStatus('error');
    };
    
    // Đăng ký tab với worker
    registerTab();
    
    updateWorkerStatus('connected');
    log('Worker initialized successfully');
  } catch (error) {
    log(`Failed to initialize worker: ${error.message}`, 'error');
    updateWorkerStatus('error');
  }
}

// Đăng ký tab hiện tại với worker
function registerTab() {
  const message = {
    type: SipWorker.MessageType.TAB_REGISTER,
    id: `register-${Date.now()}`,
    timestamp: Date.now(),
    tabId: tabId,
    data: {
      name: document.title,
      url: window.location.href,
      state: SipWorker.TabState.ACTIVE,
      mediaPermission: SipWorker.TabMediaPermission.NOT_REQUESTED
    }
  };
  
  sendMessageToWorker(message);
  updateTabIdDisplay();
}

// Gửi tin nhắn đến worker
function sendMessageToWorker(message) {
  if (worker && worker.port) {
    // Thêm tabId nếu chưa có
    if (!message.tabId) {
      message.tabId = tabId;
    }
    
    // Thêm timestamp nếu chưa có
    if (!message.timestamp) {
      message.timestamp = Date.now();
    }
    
    // Thêm id nếu chưa có
    if (!message.id) {
      message.id = `${message.type.toLowerCase()}-${Date.now()}`;
    }
    
    worker.port.postMessage(message);
    
    // Thêm tin nhắn vào lịch sử
    messageHistory.push({
      direction: 'sent',
      message: message,
      timestamp: new Date()
    });
    
    updateMessageList();
    log(`Sent message: ${JSON.stringify(message)}`);
  } else {
    log('Worker not available', 'error');
  }
}

// Xử lý tin nhắn nhận được từ worker
function handleMessage(message) {
  switch (message.type) {
    case SipWorker.MessageType.TAB_LIST_UPDATE:
      updateTabList(message.data.tabs);
      break;
    case SipWorker.MessageType.WORKER_READY:
      log('Worker is ready');
      break;
    case SipWorker.MessageType.PING:
      log('Received PING, sending PONG');
      sendMessageToWorker({
        type: SipWorker.MessageType.PONG,
        id: `pong-${message.id}`,
        timestamp: Date.now(),
        tabId: tabId,
        data: { timestamp: Date.now() }
      });
      break;
    case SipWorker.MessageType.PONG:
      log('Received PONG from worker');
      break;
    default:
      // Xử lý các loại tin nhắn khác nếu cần
      log(`Received unhandled message type: ${message.type}`);
      break;
  }
}

// Cập nhật danh sách tab trong UI
function updateTabList(tabs) {
  allTabs = tabs || {};
  const tabListElement = document.getElementById('tab-list');
  tabListElement.innerHTML = '';
  
  Object.values(allTabs).forEach((tabInfo) => {
    const tabElement = document.createElement('div');
    tabElement.className = `tab-item ${tabInfo.state.toLowerCase()}`;
    
    const tabContent = document.createElement('div');
    tabContent.textContent = `ID: ${tabInfo.id.substring(0, 8)}... | State: ${tabInfo.state}`;
    
    const tabActions = document.createElement('div');
    
    if (tabInfo.id !== tabId) {
      const sendBtn = document.createElement('button');
      sendBtn.textContent = 'Send';
      sendBtn.style.padding = '2px 5px';
      sendBtn.style.marginRight = '5px';
      sendBtn.style.fontSize = '12px';
      sendBtn.onclick = () => {
        document.getElementById('target-tab').value = tabInfo.id;
      };
      tabActions.appendChild(sendBtn);
    }
    
    tabElement.appendChild(tabContent);
    tabElement.appendChild(tabActions);
    tabListElement.appendChild(tabElement);
  });
}

// Cập nhật danh sách tin nhắn trong UI
function updateMessageList() {
  const messageListElement = document.getElementById('message-list');
  messageListElement.innerHTML = '';
  
  // Hiển thị 20 tin nhắn gần nhất
  const recentMessages = messageHistory.slice(-20);
  
  recentMessages.forEach(item => {
    const messageElement = document.createElement('div');
    messageElement.className = `message-item ${item.direction}`;
    
    const time = item.timestamp.toLocaleTimeString();
    const direction = item.direction === 'sent' ? '→' : '←';
    const type = item.message.type;
    
    messageElement.innerHTML = `
      <strong>${time} ${direction} ${type}</strong>
      <pre>${JSON.stringify(item.message, null, 2)}</pre>
    `;
    
    messageListElement.appendChild(messageElement);
  });
  
  // Cuộn xuống tin nhắn mới nhất
  messageListElement.scrollTop = messageListElement.scrollHeight;
}

// Cập nhật trạng thái worker trong UI
function updateWorkerStatus(status) {
  const statusElement = document.getElementById('worker-status');
  statusElement.textContent = `Worker Status: ${status}`;
  statusElement.className = `status ${status}`;
}

// Cập nhật hiển thị ID tab
function updateTabIdDisplay() {
  document.getElementById('tab-id').value = tabId;
}

// Tạo ID tab ngẫu nhiên
function generateTabId() {
  return 'tab_' + Math.random().toString(36).substring(2, 15);
}

// Ghi log vào UI
function log(message, level = 'info') {
  const logContainer = document.getElementById('log-container');
  const logEntry = document.createElement('p');
  logEntry.className = `log-entry log-${level}`;
  
  const timestamp = new Date().toLocaleTimeString();
  logEntry.textContent = `[${timestamp}] ${message}`;
  
  logContainer.appendChild(logEntry);
  logContainer.scrollTop = logContainer.scrollHeight;
  
  // Log ra console
  console[level](message);
}

// Thiết lập các sự kiện cho các nút
function setupEventListeners() {
  // Nút cập nhật trạng thái
  document.getElementById('update-status').addEventListener('click', () => {
    const status = document.getElementById('tab-status').value;
    let tabState;
    
    switch (status) {
      case 'active':
        tabState = SipWorker.TabState.ACTIVE;
        break;
      case 'visible':
        tabState = SipWorker.TabState.VISIBLE;
        break;
      case 'hidden':
        tabState = SipWorker.TabState.HIDDEN;
        break;
      default:
        tabState = SipWorker.TabState.ACTIVE;
    }
    
    sendMessageToWorker({
      type: SipWorker.MessageType.TAB_UPDATE_STATE,
      data: {
        state: tabState
      }
    });
  });
  
  // Nút giả lập timeout
  document.getElementById('simulate-timeout').addEventListener('click', () => {
    log('Simulating tab timeout...');
    
    // Chọn một tab ngẫu nhiên khác với tab hiện tại
    const otherTabs = Object.values(allTabs).filter(tab => tab.id !== tabId);
    
    if (otherTabs.length > 0) {
      const randomTab = otherTabs[Math.floor(Math.random() * otherTabs.length)];
      
      // Cập nhật trạng thái tab thành HIDDEN
      sendMessageToWorker({
        type: SipWorker.MessageType.TAB_UPDATE_STATE,
        tabId: randomTab.id,
        data: {
          state: SipWorker.TabState.HIDDEN
        }
      });
      
      log(`Simulated timeout for tab: ${randomTab.id}`);
    } else {
      log('No other tabs to simulate timeout');
    }
  });
  
  // Nút mở tab mới
  document.getElementById('open-new-tab').addEventListener('click', () => {
    const url = window.location.href;
    window.open(url, '_blank');
  });
  
  // Nút gửi tin nhắn
  document.getElementById('send-message').addEventListener('click', () => {
    const messageTypeSelect = document.getElementById('message-type');
    const messageType = messageTypeSelect.value;
    let messageData;
    
    try {
      messageData = JSON.parse(document.getElementById('message-data').value);
    } catch (error) {
      log('Invalid JSON data', 'error');
      return;
    }
    
    const targetTab = document.getElementById('target-tab').value || null;
    
    // Tìm MessageType tương ứng trong SipWorker.MessageType
    let actualMessageType;
    for (const type in SipWorker.MessageType) {
      if (SipWorker.MessageType[type] === messageType) {
        actualMessageType = SipWorker.MessageType[type];
        break;
      }
    }
    
    if (!actualMessageType) {
      log(`Unknown message type: ${messageType}`, 'error');
      return;
    }
    
    sendMessageToWorker({
      type: actualMessageType,
      targetTabId: targetTab,
      data: messageData
    });
  });
  
  // Nút xóa tin nhắn
  document.getElementById('clear-messages').addEventListener('click', () => {
    messageHistory = [];
    updateMessageList();
  });
  
  // Nút xóa logs
  document.getElementById('clear-logs').addEventListener('click', () => {
    document.getElementById('log-container').innerHTML = '';
  });
  
  // Nút gửi ping
  document.getElementById('send-ping').addEventListener('click', () => {
    sendMessageToWorker({
      type: SipWorker.MessageType.PING,
      data: { timestamp: Date.now() }
    });
  });
  
  // Xử lý sự kiện khi tab được đóng
  window.addEventListener('beforeunload', () => {
    if (worker && worker.port) {
      sendMessageToWorker({
        type: SipWorker.MessageType.TAB_UNREGISTER
      });
    }
  });
  
  // Xử lý sự kiện khi tab thay đổi trạng thái hiển thị
  document.addEventListener('visibilitychange', () => {
    const state = document.visibilityState === 'visible' ? 
      SipWorker.TabState.ACTIVE : 
      SipWorker.TabState.HIDDEN;
    
    sendMessageToWorker({
      type: SipWorker.MessageType.TAB_UPDATE_STATE,
      data: {
        state: state
      }
    });
    
    // Cập nhật dropdown
    document.getElementById('tab-status').value = state.toLowerCase();
  });
}

// Khởi tạo ứng dụng
function initializeApp() {
  setupEventListeners();
  initializeWorker();
  
  // Gửi ping định kỳ để kiểm tra kết nối
  setInterval(() => {
    if (worker && worker.port) {
      sendMessageToWorker({
        type: SipWorker.MessageType.PING,
        data: { timestamp: Date.now() }
      });
    }
  }, 30000); // Mỗi 30 giây
}

// Chạy ứng dụng khi trang đã tải xong
document.addEventListener('DOMContentLoaded', initializeApp); 