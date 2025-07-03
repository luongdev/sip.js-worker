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

// Các phần tử DOM
const registerBtn = document.getElementById('registerBtn');
const unregisterBtn = document.getElementById('unregisterBtn');
const updateCredentialsBtn = document.getElementById('updateCredentialsBtn');
const sipUriInput = document.getElementById('sipUri');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const displayNameInput = document.getElementById('displayName');
const wsServerInput = document.getElementById('wsServer');
const newUsernameInput = document.getElementById('newUsername');
const newPasswordInput = document.getElementById('newPassword');
const logContainer = document.getElementById('logContainer');

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
    
    addLog('info', 'Worker initialized successfully');
  } catch (error) {
    addLog('error', `Failed to initialize worker: ${error.message}`);
  }
}

// Đăng ký tab với worker
function registerTab() {
  sendMessage({
    type: SipWorker.MessageType.TAB_REGISTER,
    id: `register-${Date.now()}`,
    tabId: tabId,
    timestamp: Date.now(),
    data: {
      id: tabId,
      name: document.title,
      url: window.location.href,
      state: document.visibilityState === 'visible' ? 
        (document.hasFocus() ? SipWorker.TabState.ACTIVE : SipWorker.TabState.VISIBLE) : 
        SipWorker.TabState.HIDDEN,
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
      break;
      
    case SipWorker.MessageType.SIP_REGISTERED:
      addLog('info', `SIP registered successfully: ${JSON.stringify(message.data)}`);
      isRegistered = true;
      registerBtn.disabled = true;
      unregisterBtn.disabled = false;
      updateCredentialsBtn.disabled = false;
      break;
      
    case SipWorker.MessageType.SIP_UNREGISTERED:
      addLog('info', 'SIP unregistered');
      isRegistered = false;
      registerBtn.disabled = false;
      unregisterBtn.disabled = true;
      updateCredentialsBtn.disabled = true;
      break;
      
    case SipWorker.MessageType.SIP_REGISTRATION_FAILED:
      addLog('error', `SIP registration failed: ${message.data?.error || 'Unknown error'}`);
      isRegistered = false;
      registerBtn.disabled = false;
      unregisterBtn.disabled = true;
      updateCredentialsBtn.disabled = true;
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
  logEntry.textContent = `[${new Date().toLocaleTimeString()}] [${level.toUpperCase()}] ${message}`;
  logContainer.appendChild(logEntry);
  logContainer.scrollTop = logContainer.scrollHeight;
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
}

// Hủy đăng ký SIP
function unregisterSip() {
  sendMessage({
    type: SipWorker.MessageType.SIP_UNREGISTER,
    id: `sip-unregister-${Date.now()}`,
    tabId: tabId,
    timestamp: Date.now()
  });
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
}

// Thiết lập các sự kiện
registerBtn.addEventListener('click', registerSip);
unregisterBtn.addEventListener('click', unregisterSip);
updateCredentialsBtn.addEventListener('click', updateCredentials);

// Khởi tạo worker khi trang được tải
window.addEventListener('load', initWorker);

// Cập nhật trạng thái tab khi thay đổi visibility
document.addEventListener('visibilitychange', () => {
  if (!port) return;
  
  const state = document.visibilityState === 'visible' ?
    (document.hasFocus() ? SipWorker.TabState.ACTIVE : SipWorker.TabState.VISIBLE) :
    SipWorker.TabState.HIDDEN;
    
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
});

// Cập nhật trạng thái tab khi focus/blur
window.addEventListener('focus', () => {
  if (!port) return;
  
  sendMessage({
    type: SipWorker.MessageType.TAB_UPDATE_STATE,
    id: `tab-update-${Date.now()}`,
    tabId: tabId,
    timestamp: Date.now(),
    data: {
      state: SipWorker.TabState.ACTIVE,
      lastActiveTime: Date.now()
    }
  });
});

window.addEventListener('blur', () => {
  if (!port) return;
  
  sendMessage({
    type: SipWorker.MessageType.TAB_UPDATE_STATE,
    id: `tab-update-${Date.now()}`,
    tabId: tabId,
    timestamp: Date.now(),
    data: {
      state: SipWorker.TabState.VISIBLE
    }
  });
});

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