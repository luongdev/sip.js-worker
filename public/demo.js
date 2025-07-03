/**
 * Demo script for SIP Worker
 */

// Import từ thư viện
import '../src/style.css';
import { SipWorker } from '../src/common/types';

// Khởi tạo SharedWorker
let worker = null;
let port = null;
let tabId = `tab-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
let isRegistered = false;
let isWorkerConnected = false;

// Các phần tử DOM
const registerBtn = document.getElementById('registerBtn');
const unregisterBtn = document.getElementById('unregisterBtn');
const updateCredentialsBtn = document.getElementById('updateCredentialsBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const sipUriInput = document.getElementById('sipUri');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const displayNameInput = document.getElementById('displayName');
const wsServerInput = document.getElementById('wsServer');
const newUsernameInput = document.getElementById('newUsername');
const newPasswordInput = document.getElementById('newPassword');
const logContainer = document.getElementById('logContainer');
const workerStatus = document.getElementById('workerStatus');
const sipStatus = document.getElementById('sipStatus');

// Khởi tạo worker
function initWorker() {
  try {
    worker = new SharedWorker('/src/worker/index.ts', { type: 'module' });
    port = worker.port;
    
    // Thiết lập xử lý tin nhắn từ worker
    port.onmessage = handleWorkerMessage;
    
    // Khởi động port
    port.start();
    
    // Đăng ký tab
    registerTab();
    
    // Cập nhật trạng thái worker
    updateWorkerStatus(true);
    
    addLog('info', 'Worker initialized successfully');
  } catch (error) {
    updateWorkerStatus(false);
    addLog('error', `Failed to initialize worker: ${error.message}`);
  }
}

// Cập nhật trạng thái worker
function updateWorkerStatus(connected) {
  isWorkerConnected = connected;
  workerStatus.textContent = `Worker: ${connected ? 'Connected' : 'Disconnected'}`;
  workerStatus.className = `status status-${connected ? 'connected' : 'disconnected'}`;
  
  // Disable các nút nếu worker không kết nối
  registerBtn.disabled = !connected;
  unregisterBtn.disabled = !connected || !isRegistered;
  updateCredentialsBtn.disabled = !connected || !isRegistered;
}

// Cập nhật trạng thái SIP
function updateSipStatus(registered) {
  isRegistered = registered;
  sipStatus.textContent = `SIP: ${registered ? 'Registered' : 'Unregistered'}`;
  sipStatus.className = `status status-${registered ? 'registered' : 'unregistered'}`;
  
  // Cập nhật trạng thái các nút
  registerBtn.disabled = registered;
  unregisterBtn.disabled = !registered;
  updateCredentialsBtn.disabled = !registered;
}

// Đăng ký tab với worker
function registerTab() {
  // Set state ban đầu
  currentState = document.visibilityState === 'visible' ? 
    (document.hasFocus() ? SipWorker.TabState.ACTIVE : SipWorker.TabState.VISIBLE) : 
    SipWorker.TabState.HIDDEN;
    
  sendMessage({
    type: SipWorker.MessageType.TAB_REGISTER,
    id: `register-${Date.now()}`,
    tabId: tabId,
    timestamp: Date.now(),
    data: {
      id: tabId,
      name: document.title,
      url: window.location.href,
      state: currentState,
      lastActiveTime: Date.now(),
      createdTime: Date.now(),
      mediaPermission: SipWorker.TabMediaPermission.NOT_REQUESTED,
      handlingCall: false
    }
  });
}

// Gửi tin nhắn đến worker
function sendMessage(message) {
  if (!port) {
    addLog('error', 'Worker not initialized');
    return;
  }
  
  addLog('info', `Sending message: ${message.type}`);
  port.postMessage(message);
}

// Xử lý tin nhắn từ worker
function handleWorkerMessage(event) {
  const message = event.data;
  
  addLog('info', `Received message: ${message.type}`);
  
  switch (message.type) {
    case SipWorker.MessageType.WORKER_READY:
      addLog('info', 'Worker is ready');
      updateWorkerStatus(true);
      break;
      
    case SipWorker.MessageType.SIP_REGISTERED:
      addLog('info', `SIP registered successfully: ${JSON.stringify(message.data)}`);
      updateSipStatus(true);
      break;
      
    case SipWorker.MessageType.SIP_UNREGISTERED:
      addLog('info', 'SIP unregistered');
      updateSipStatus(false);
      break;
      
    case SipWorker.MessageType.SIP_REGISTRATION_FAILED:
      addLog('error', `SIP registration failed: ${message.data?.error || 'Unknown error'}`);
      updateSipStatus(false);
      break;
      
    case SipWorker.MessageType.LOG:
      if (message.data) {
        addLog(message.data.level, message.data.message);
      }
      break;
      
    default:
      addLog('debug', `Unhandled message type: ${message.type}`);
      break;
  }
}

// Thêm log vào container
function addLog(level, message) {
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry log-${level}`;
  
  const timestamp = new Date().toLocaleTimeString();
  logEntry.textContent = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  logContainer.appendChild(logEntry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// Xóa tất cả log
function clearLogs() {
  logContainer.innerHTML = '';
  addLog('info', 'Logs cleared');
}

// Đăng ký SIP
function registerSip() {
  const sipConfig = {
    uri: sipUriInput.value,
    username: usernameInput.value,
    password: passwordInput.value,
    displayName: displayNameInput.value
  };
  
  const transportConfig = {
    server: wsServerInput.value
  };
  
  sendMessage({
    type: SipWorker.MessageType.SIP_REGISTER,
    id: `sip-register-${Date.now()}`,
    tabId: tabId,
    timestamp: Date.now(),
    data: {
      sipConfig,
      transportConfig
    }
  });
  
  // Disable nút register trong khi đang xử lý
  registerBtn.disabled = true;
}

// Hủy đăng ký SIP
function unregisterSip() {
  sendMessage({
    type: SipWorker.MessageType.SIP_UNREGISTER,
    id: `sip-unregister-${Date.now()}`,
    tabId: tabId,
    timestamp: Date.now()
  });
  
  // Disable nút unregister trong khi đang xử lý
  unregisterBtn.disabled = true;
}

// Cập nhật thông tin đăng nhập
function updateCredentials() {
  sendMessage({
    type: SipWorker.MessageType.SIP_UPDATE_CREDENTIALS,
    id: `sip-update-credentials-${Date.now()}`,
    tabId: tabId,
    timestamp: Date.now(),
    data: {
      username: newUsernameInput.value,
      password: newPasswordInput.value
    }
  });
  
  // Disable nút update trong khi đang xử lý
  updateCredentialsBtn.disabled = true;
}

// Thiết lập các sự kiện
registerBtn.addEventListener('click', registerSip);
unregisterBtn.addEventListener('click', unregisterSip);
updateCredentialsBtn.addEventListener('click', updateCredentials);
clearLogsBtn.addEventListener('click', clearLogs);

// Khởi tạo worker khi trang được tải
window.addEventListener('load', initWorker);

// Biến để debounce cập nhật trạng thái
let stateUpdateTimeout = null;

// Biến lưu state hiện tại để tránh update duplicate
let currentState = null;

// Hàm cập nhật trạng thái tab (debounced để tránh spam)
function updateTabState(eventType) {
  if (!port) return;
  
  // Clear timeout cũ nếu có
  if (stateUpdateTimeout) {
    clearTimeout(stateUpdateTimeout);
  }
  
  // Debounce 50ms để tránh nhiều update liên tiếp
  stateUpdateTimeout = setTimeout(() => {
    const state = document.visibilityState === 'visible' ?
      (document.hasFocus() ? SipWorker.TabState.ACTIVE : SipWorker.TabState.VISIBLE) :
      SipWorker.TabState.HIDDEN;
    
    // Chỉ gửi nếu state thực sự thay đổi
    if (state === currentState) {
      console.log(`Skip duplicate state update: ${state} (triggered by ${eventType})`);
      return;
    }
    
    console.log(`State changed from ${currentState} to ${state} (triggered by ${eventType})`);
    currentState = state;
      
    sendMessage({
      type: SipWorker.MessageType.TAB_UPDATE_STATE,
      id: `tab-update-${Date.now()}`,
      tabId: tabId,
      timestamp: Date.now(),
      data: {
        state,
        lastActiveTime: state === SipWorker.TabState.ACTIVE ? Date.now() : undefined
      }
    });
  }, 50);
}

// Cập nhật trạng thái tab khi thay đổi visibility hoặc focus
document.addEventListener('visibilitychange', () => updateTabState('visibilitychange'));
window.addEventListener('focus', () => updateTabState('focus'));
window.addEventListener('blur', () => updateTabState('blur'));

// Xử lý khi đóng tab
window.addEventListener('beforeunload', () => {
  if (!port) return;
  
  sendMessage({
    type: SipWorker.MessageType.TAB_UNREGISTER,
    id: `tab-unregister-${Date.now()}`,
    tabId: tabId,
    timestamp: Date.now()
  });
}); 