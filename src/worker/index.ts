/**
 * Worker entry point
 */

import { MessageBroker } from './message-broker';
import { TabManager } from './tab-manager';
import { SipCore, SipCoreOptions } from './sip-core';
import { WorkerState } from './worker-state';
import { SipWorker, VERSION } from '../common/types';

// Khởi tạo WorkerState
const workerState = new WorkerState();

// Khởi tạo MessageBroker
const messageBroker = new MessageBroker();

// Set WorkerState reference cho MessageBroker
messageBroker.setWorkerState(workerState);

// Khởi tạo TabManager
const tabManager = new TabManager(messageBroker, workerState);

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

self.addEventListener('connect', (event: any) => {
  const port = event.ports[0];
  
  port.start();
  
  const handleFirstMessage = (messageEvent: MessageEvent) => {
    const message = messageEvent.data;
    
    // Lấy tabId từ tin nhắn đầu tiên
    const tabId = message.tabId;
    
    if (tabId) {
      messageBroker.registerTab(tabId, port);
      
      port.removeEventListener('message', handleFirstMessage);
      
      port.onmessage = (event: MessageEvent) => {
        messageBroker.processMessage(event.data, tabId, port);
      };
      
      messageBroker.processMessage(message, tabId, port);
    } else {
      console.error('Tin nhắn đầu tiên không có tabId');
    }
  };
  
  port.addEventListener('message', handleFirstMessage);
});

// Đăng ký các handler xử lý tin nhắn
function registerMessageHandlers() {
  // Handler cho STATE_REQUEST - tab yêu cầu đồng bộ trạng thái
  messageBroker.on(SipWorker.MessageType.STATE_REQUEST, async (message, tabId, port) => {
    // Gửi trạng thái hiện tại về tab yêu cầu
    const currentState = workerState.getSerializableState();
    
    messageBroker.sendToTab(tabId, {
      type: SipWorker.MessageType.STATE_SYNC,
      id: `state-sync-${Date.now()}`,
      timestamp: Date.now(),
      data: currentState
    });
    
    return { success: true, message: 'State synced' };
  });
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
      
      sipCore = new SipCore(messageBroker, tabManager, options, workerState);
      
      // Đăng ký SIP
      const result = await sipCore.register();
      
      // Note: State sync will be handled by STATE_REQUEST, don't send duplicate
      return result;
    } else {
      // Nếu đã có SipCore, chỉ cần đăng ký lại với thông tin mới
      const credentials = data.sipConfig || {};
      const result = await sipCore.register(credentials);
      
      // Note: State sync will be handled by STATE_REQUEST, don't send duplicate
      return result;
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

  // Handler cho tin nhắn SIP_UPDATE_CONFIG
  messageBroker.on(SipWorker.MessageType.SIP_UPDATE_CONFIG, async (message, tabId, port) => {
    if (sipCore) {
      sipCore.updateConfig(message.data || {});
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

  // Handler cho tin nhắn CALL_HANGUP
  messageBroker.on(SipWorker.MessageType.CALL_HANGUP, async (message, tabId, port) => {
    if (sipCore) {
      const request = message.data as { callId: string };
      return await sipCore.hangupCall(request.callId);
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho tin nhắn CALL_ANSWER (chấp nhận cuộc gọi đến)
  messageBroker.on(SipWorker.MessageType.CALL_ANSWER, async (message, tabId, port) => {
    if (sipCore) {
      const request = message.data as { callId: string };
      return await sipCore.acceptCall(request.callId);
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho tin nhắn CALL_REJECT (từ chối cuộc gọi đến)
  messageBroker.on(SipWorker.MessageType.CALL_REJECT, async (message, tabId, port) => {
    if (sipCore) {
      const request = message.data as { callId: string; statusCode?: number; reasonPhrase?: string };
      return await sipCore.rejectCall(request.callId, request.statusCode, request.reasonPhrase);
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho ICE candidate từ tab
  messageBroker.on(SipWorker.MessageType.MEDIA_ICE_CANDIDATE, async (message, tabId, port) => {
    console.log('Worker received ICE candidate from tab:', tabId, message.data);
    
    if (sipCore) {
      // Forward ICE candidate tới SIP Core để gửi tới remote peer
      // TODO: Implement ICE candidate forwarding in SipCore
      return { success: true, message: 'ICE candidate received' };
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho DTMF_SEND
  messageBroker.on(SipWorker.MessageType.DTMF_SEND, async (message, tabId, port) => {
    if (sipCore) {
      // Validate message data
      if (!message.data || typeof message.data !== 'object') {
        console.error('Invalid DTMF_SEND message - missing data:', message);
        return { success: false, error: 'Invalid DTMF request: missing data' };
      }
      
      const request = message.data as SipWorker.DtmfRequest;
      
      // Validate required fields
      if (!request.callId || !request.tones) {
        console.error('Invalid DTMF_SEND message - missing callId or tones:', request);
        return { success: false, error: 'Invalid DTMF request: missing callId or tones' };
      }
      
      const result = await sipCore.sendDtmf(request.callId, request.tones, {
        duration: request.duration,
        interToneGap: request.interToneGap
      });
      
      if (result.success) {
        // Gửi phản hồi thành công về tab
        messageBroker.sendToTab(tabId, {
          type: SipWorker.MessageType.DTMF_SENT,
          id: `dtmf-sent-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            callId: request.callId,
            success: true,
            tones: request.tones
          } as SipWorker.DtmfResponse
        });
      } else {
        // Gửi phản hồi thất bại về tab
        messageBroker.sendToTab(tabId, {
          type: SipWorker.MessageType.DTMF_FAILED,
          id: `dtmf-failed-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            callId: request.callId,
            success: false,
            tones: request.tones,
            error: result.error
          } as SipWorker.DtmfResponse
        });
      }
      
      return result;
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho SDP Cache
  messageBroker.on(SipWorker.MessageType.MEDIA_SDP_CACHE, async (message, tabId, port) => {
    console.log('Received SDP cache request:', message.data);
    if (sipCore && workerState) {
      const data = message.data as SipWorker.SdpCacheRequest;
      if (data && data.callId && (data.localSdp || data.remoteSdp)) {
        const callInfo = workerState.getActiveCall(data.callId);
        console.log('CallInfo for SDP cache:', data.callId, !!callInfo);
        if (callInfo) {
          console.log('Caching SDP for hold/unhold:', data.callId, 'local length:', data.localSdp.length, 'remote length:', data.remoteSdp.length);
          workerState.setActiveCall(data.callId, {
            ...callInfo,
            originalSdp: {
              local: callInfo.originalSdp?.local ?? data.localSdp,
              remote: callInfo.originalSdp?.remote ?? data.remoteSdp
            }
          });
          
          // Verify it was cached
          const updatedCallInfo = workerState.getActiveCall(data.callId);
          console.log('Verified SDP cache:', data.callId, updatedCallInfo);
          
          return { success: true };
        } else {
          console.log('No callInfo found for SDP cache:', data.callId);
        }
      } else {
        console.log('Invalid SDP cache data:', data);
      }
    }
    return { success: false, error: 'Failed to cache SDP' };
  });

  // Handler cho CALL_MUTE
  messageBroker.on(SipWorker.MessageType.CALL_MUTE, async (message, tabId, port) => {
    if (sipCore) {
      const request = message.data as SipWorker.CallControlRequest;
      const result = await sipCore.muteCall(request.callId);
      
      messageBroker.sendToTab(tabId, {
        type: result.success ? SipWorker.MessageType.CALL_MUTED : SipWorker.MessageType.CALL_TRANSFER_FAILED,
        id: `mute-response-${Date.now()}`,
        timestamp: Date.now(),
        data: {
          callId: request.callId,
          success: result.success,
          action: 'mute',
          error: result.error
        } as SipWorker.CallControlResponse
      });
      
      return result;
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho CALL_UNMUTE
  messageBroker.on(SipWorker.MessageType.CALL_UNMUTE, async (message, tabId, port) => {
    if (sipCore) {
      const request = message.data as SipWorker.CallControlRequest;
      const result = await sipCore.unmuteCall(request.callId);
      
      messageBroker.sendToTab(tabId, {
        type: result.success ? SipWorker.MessageType.CALL_UNMUTED : SipWorker.MessageType.CALL_TRANSFER_FAILED,
        id: `unmute-response-${Date.now()}`,
        timestamp: Date.now(),
        data: {
          callId: request.callId,
          success: result.success,
          action: 'unmute',
          error: result.error
        } as SipWorker.CallControlResponse
      });
      
      return result;
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho CALL_HOLD
  messageBroker.on(SipWorker.MessageType.CALL_HOLD, async (message, tabId, port) => {
    if (sipCore) {
      const request = message.data as SipWorker.CallControlRequest;
      const result = await sipCore.holdCall(request.callId);
      
      messageBroker.sendToTab(tabId, {
        type: result.success ? SipWorker.MessageType.CALL_HELD : SipWorker.MessageType.CALL_TRANSFER_FAILED,
        id: `hold-response-${Date.now()}`,
        timestamp: Date.now(),
        data: {
          callId: request.callId,
          success: result.success,
          action: 'hold',
          error: result.error
        } as SipWorker.CallControlResponse
      });
      
      return result;
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho CALL_UNHOLD
  messageBroker.on(SipWorker.MessageType.CALL_UNHOLD, async (message, tabId, port) => {
    if (sipCore) {
      const request = message.data as SipWorker.CallControlRequest;
      const result = await sipCore.unholdCall(request.callId);
      
      messageBroker.sendToTab(tabId, {
        type: result.success ? SipWorker.MessageType.CALL_UNHELD : SipWorker.MessageType.CALL_TRANSFER_FAILED,
        id: `unhold-response-${Date.now()}`,
        timestamp: Date.now(),
        data: {
          callId: request.callId,
          success: result.success,
          action: 'unhold',
          error: result.error
        } as SipWorker.CallControlResponse
      });
      
      return result;
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho CALL_TRANSFER
  messageBroker.on(SipWorker.MessageType.CALL_TRANSFER, async (message, tabId, port) => {
    if (sipCore) {
      const request = message.data as SipWorker.CallTransferRequest;
      const result = await sipCore.transferCall(request.callId, request.targetUri, request.extraHeaders);
      
      messageBroker.sendToTab(tabId, {
        type: result.success ? SipWorker.MessageType.CALL_TRANSFERRED : SipWorker.MessageType.CALL_TRANSFER_FAILED,
        id: `transfer-response-${Date.now()}`,
        timestamp: Date.now(),
        data: {
          callId: request.callId,
          success: result.success,
          action: 'transfer',
          error: result.error
        } as SipWorker.CallControlResponse
      });
      
      return result;
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho session ready từ tab  
  messageBroker.on(SipWorker.MessageType.MEDIA_SESSION_READY, async (message, tabId, port) => {
    console.log('Worker received session ready from tab:', tabId, message.data);
    
    if (sipCore) {
      // Notify SIP Core that media session is ready
      // TODO: Implement session ready handling in SipCore
      return { success: true, message: 'Session ready received' };
    }
    return { success: false, error: 'SIP not initialized' };
  });

  // Handler cho session failed từ tab
  messageBroker.on(SipWorker.MessageType.MEDIA_SESSION_FAILED, async (message, tabId, port) => {
    console.log('Worker received session failed from tab:', tabId, message.data);
    
    if (sipCore) {
      // Notify SIP Core that media session failed
      // TODO: Implement session failed handling in SipCore
      return { success: true, message: 'Session failed received' };
    }
    return { success: false, error: 'SIP not initialized' };
  });
  
  // Handler cho CALL_MUTED response từ client
  messageBroker.on(SipWorker.MessageType.CALL_MUTED, async (message, tabId, port) => {
    console.log('Worker received CALL_MUTED response from tab:', tabId, message.data);
    
    const response = message.data as SipWorker.CallControlResponse;
    if (response && response.success) {
      console.log(`Call ${response.callId} muted successfully in tab ${tabId}`);
      
      // Broadcast muted status to all tabs for UI sync
      messageBroker.broadcast({
        type: SipWorker.MessageType.CALL_MUTED,
        id: `mute-broadcast-${Date.now()}`,
        timestamp: Date.now(),
        data: response
      });
    }
    
    return { success: true };
  });

  // Handler cho CALL_UNMUTED response từ client
  messageBroker.on(SipWorker.MessageType.CALL_UNMUTED, async (message, tabId, port) => {
    console.log('Worker received CALL_UNMUTED response from tab:', tabId, message.data);
    
    const response = message.data as SipWorker.CallControlResponse;
    if (response && response.success) {
      console.log(`Call ${response.callId} unmuted successfully in tab ${tabId}`);
      
      // Broadcast unmuted status to all tabs for UI sync
      messageBroker.broadcast({
        type: SipWorker.MessageType.CALL_UNMUTED,
        id: `unmute-broadcast-${Date.now()}`,
        timestamp: Date.now(),
        data: response
      });
    }
    
    return { success: true };
  });

  // Handler cho cập nhật media permission
  messageBroker.on(SipWorker.MessageType.TAB_UPDATE_STATE, async (message, tabId, port) => {
    const data = message.data;
    
    // Update media permission in WorkerState if provided
    if (data && data.mediaPermission) {
      workerState.setTabPermission(tabId, data.mediaPermission);
    }
    
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