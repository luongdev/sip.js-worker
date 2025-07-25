import { SipWorker } from '../common/types';
import { MediaHandler, MediaHandlerCallbacks, MediaHandlerConfiguration } from './media-handler';
import { v7 as uuidv7, validate as uuidValidate } from 'uuid';

export interface SipWorkerClientOptions {
  tabId?: string;
  workerPath?: string;
  type?: ('classic' | 'module');
}

/**
 * SipWorkerClient class để kết nối với SharedWorker và xử lý media
 */
export class SipWorkerClient {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private mediaHandler: MediaHandler;
  private tabId: string;
  private connected: boolean = false;
  private messageHandlers: Map<SipWorker.MessageType, Function[]> = new Map();
  
  // New: ServiceWorker notification support
  private notificationChannel: BroadcastChannel | null = null;
  private serviceWorkerRegistration: ServiceWorkerRegistration | null = null;

  /**
   * Khởi tạo SipWorkerClient
   * @param workerPath Đường dẫn đến worker script
   * @param tabId ID của tab (optional, sẽ tự tạo nếu không có)
   */
  constructor(options?: SipWorkerClientOptions, mediaOptions?: MediaHandlerConfiguration) {
    this.tabId = options?.tabId || `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const workerPath = options?.workerPath || new URL('../worker/index.ts', import.meta.url).toString();
    const type = options?.type || 'module';

    // Create callbacks for MediaHandler
    const mediaCallbacks: MediaHandlerCallbacks = {
      sendIceCandidate: (callId: string, candidate: RTCIceCandidate) => {
        // Send ICE candidate to worker
        const message: SipWorker.Message = {
          type: SipWorker.MessageType.MEDIA_ICE_CANDIDATE,
          id: `ice-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            callId,
            candidate: candidate.toJSON()
          }
        };
        this.sendMessage(message);
      },
      sendSessionReady: (callId: string) => {
        // Send session ready to worker
        const message: SipWorker.Message = {
          type: SipWorker.MessageType.MEDIA_SESSION_READY,
          id: `ready-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            callId,
            success: true
          }
        };
        this.sendMessage(message);
      },
      sendSessionFailed: (callId: string, error: string) => {
        // Send session failed to worker
        const message: SipWorker.Message = {
          type: SipWorker.MessageType.MEDIA_SESSION_FAILED,
          id: `failed-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            callId,
            success: false,
            error
          }
        };
        this.sendMessage(message);
      },
      handleRemoteStream: (callId: string, stream: MediaStream) => {
        console.log('Received remote stream for call:', callId);
        
        // Try to find audio element with various common IDs
        let audioElement = document.getElementById('remoteAudio') as HTMLAudioElement;
        if (!audioElement) {
          audioElement = document.getElementById('remote-audio') as HTMLAudioElement;
        }
        if (!audioElement) {
          audioElement = document.querySelector('audio[data-remote]') as HTMLAudioElement;
        }
        if (!audioElement) {
          audioElement = document.querySelector('audio.remote') as HTMLAudioElement;
        }
        
        // If still no element found, create one dynamically
        if (!audioElement) {
          console.log('No remote audio element found, creating one...');
          audioElement = document.createElement('audio');
          audioElement.id = 'remoteAudio';
          audioElement.autoplay = true;
          audioElement.controls = false;
          audioElement.style.display = 'none'; // Hidden by default
          document.body.appendChild(audioElement);
          console.log('Created remote audio element with id "remoteAudio"');
        }
        
        // Set the stream
        audioElement.srcObject = stream;
        console.log('Remote audio stream set successfully on element:', audioElement.id);
        
        // Emit custom event for external handling
        const remoteStreamEvent = new CustomEvent('sipRemoteStream', {
          detail: { callId, stream, audioElement }
        });
        window.dispatchEvent(remoteStreamEvent);
        
        // Also try to call a global callback if it exists
        if (typeof (window as any).onSipRemoteStream === 'function') {
          (window as any).onSipRemoteStream(callId, stream, audioElement);
        }
      },
      sendSdpCache: (callId: string, localSdp: string, remoteSdp: string) => {
        console.log('Sending SDP cache to worker for call:', callId);
        this.sendMessage({
          type: SipWorker.MessageType.MEDIA_SDP_CACHE,
          id: `sdp-cache-${Date.now()}`,
          tabId: this.tabId,
          timestamp: Date.now(),
          data: {
            callId,
            localSdp,
            remoteSdp
          }
        });
      }
    };
    
    this.mediaHandler = new MediaHandler(mediaCallbacks, mediaOptions);
    
    // Khởi tạo SharedWorker
    this.initWorker(workerPath, type);
    
    // Đăng ký media handlers
    this.registerMediaHandlers();
    
    // New: Khởi tạo ServiceWorker cho notifications
    this.initServiceWorkerNotifications();
  }

  /**
   * Initialize ServiceWorker for push notifications
   */
  private async initServiceWorkerNotifications(): Promise<void> {
    try {
      // Check ServiceWorker support
      if (!('serviceWorker' in navigator)) {
        console.warn('ServiceWorker not supported, notifications will use fallback');
        return;
      }

      // Register ServiceWorker
      this.serviceWorkerRegistration = await navigator.serviceWorker.register(
        '/sw.js',
        { scope: '/' }
      );

      console.log('SIP Notifications ServiceWorker registered successfully');

      // Setup BroadcastChannel communication
      this.notificationChannel = new BroadcastChannel('sip-notifications');
      
      // Note: Client does NOT listen for notification actions from BroadcastChannel
      // to avoid duplicate processing. Only SharedWorker handles notification actions.
      // Client only receives UI feedback via ServiceWorker postMessage.

      // Listen for ServiceWorker messages
      navigator.serviceWorker.addEventListener('message', (event) => {
        this.handleServiceWorkerMessage(event.data);
      });

      // Request notification permission if not granted
      await this.requestNotificationPermission();

    } catch (error) {
      console.warn('Failed to initialize ServiceWorker notifications:', error);
      // Fallback to tab-based notifications if ServiceWorker fails
    }
  }

  /**
   * Request notification permission
   */
  private async requestNotificationPermission(): Promise<void> {
    if (!('Notification' in window)) {
      console.warn('Browser notifications not supported');
      return;
    }

    if (Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      console.log('Notification permission:', permission);
    }
  }

  /**
   * Handle notification actions from ServiceWorker
   */
  private handleNotificationAction(data: any): void {
    console.log('handleNotificationAction called with data:', data);
    console.log('Data type:', typeof data, 'Keys:', Object.keys(data || {}));
    
    const { type, action, callId } = data;
    
    console.log('Extracted values - type:', type, 'action:', action, 'callId:', callId);
    
    if (type === 'NOTIFICATION_ACTION') {
      console.log(`Notification action received: "${action}" for call ${callId}`);
      
      // Focus window
      window.focus();
      
      // Execute action
      switch (action) {
        case 'answer':
          console.log('Executing answer action for call:', callId);
          this.answerCall(callId);
          break;
        case 'reject':
          console.log('Executing reject action for call:', callId);
          this.rejectCall(callId);
          break;
        default:
          console.warn(`Unknown notification action: "${action}" (type: ${typeof action})`);
          console.warn('Full data object:', JSON.stringify(data, null, 2));
      }

      // Emit custom event for external handling
      const notificationEvent = new CustomEvent('sipNotificationAction', {
        detail: { action, callId }
      });
      window.dispatchEvent(notificationEvent);
    } else {
      console.warn('Invalid notification action type:', type, 'Expected: NOTIFICATION_ACTION');
    }
  }

  /**
   * Handle ServiceWorker messages
   */
  private handleServiceWorkerMessage(data: any): void {
    const { type } = data;
    
    switch (type) {
      case 'NOTIFICATION_ACTION':
        // Legacy: still handle for backward compatibility
        this.handleNotificationAction(data);
        break;
      case 'NOTIFICATION_UI_FEEDBACK':
        // Only for UI feedback, don't execute action (SharedWorker handles it)
        console.log('Notification UI feedback:', data.action, 'for call:', data.callId);
        
        // Emit custom event for external handling
        const notificationEvent = new CustomEvent('sipNotificationAction', {
          detail: { action: data.action, callId: data.callId }
        });
        window.dispatchEvent(notificationEvent);
        break;
      default:
        console.log('Unknown ServiceWorker message:', type);
    }
  }

  /**
   * Khởi tạo SharedWorker
   */
  private initWorker(workerPath?: string, type?: ('classic' | 'module')): void {
    try {
      this.worker = new SharedWorker(workerPath ?? new URL('../worker/index.ts', import.meta.url), { name: 'SipWorker', type: type ?? 'module' });
      this.port = this.worker.port;

      // Thiết lập message handler
      this.port.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      // Thiết lập error handler
      this.port.onmessageerror = (error) => {
        console.error('SharedWorker message error:', error);
        this.emitEvent('error', {
          type: SipWorker.MessageType.ERROR,
          id: `error-${Date.now()}`,
          timestamp: Date.now(),
          error: {
            code: 'MESSAGE_ERROR',
            message: `SharedWorker message error: ${error.data || 'Unknown error'}`
          }
        });
      };

      // Thiết lập worker error handler
      this.worker.onerror = (error) => {
        console.error('SharedWorker error:', error);
        this.connected = false;
        this.emitEvent('error', {
          type: SipWorker.MessageType.ERROR,
          id: `error-${Date.now()}`,
          timestamp: Date.now(),
          error: {
            code: 'WORKER_ERROR',
            message: `SharedWorker error: ${error.message || error.filename}:${error.lineno}`
          }
        });
      };

      // Connection timeout - worker should respond within 5 seconds
      const connectionTimeout = setTimeout(() => {
        if (!this.connected) {
          console.error('SharedWorker connection timeout');
          this.emitEvent('error', {
            type: SipWorker.MessageType.ERROR,
            id: `error-${Date.now()}`,
            timestamp: Date.now(),
            error: {
              code: 'CONNECTION_TIMEOUT',
              message: 'SharedWorker connection timeout after 5 seconds'
            }
          });
        }
      }, 5000);

      // Clear timeout when connected
      this.on('worker_ready', () => {
        clearTimeout(connectionTimeout);
      });

      // Bắt đầu kết nối
      this.port.start();

      // Đăng ký tab với worker
      this.registerTab();

      console.log('SipWorkerClient initialized with tabId:', this.tabId);
    } catch (error) {
      console.error('Failed to initialize SharedWorker:', error);
    }
  }

  /**
   * Đăng ký tab với worker
   */
  private registerTab(): void {
    this.sendMessage({
      type: SipWorker.MessageType.TAB_REGISTER,
      id: `register-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: {
        name: document.title || 'Unknown Tab',
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

  /**
   * Đăng ký media handlers
   */
  private registerMediaHandlers(): void {
    // Xử lý media requests từ worker
    this.on(SipWorker.MessageType.MEDIA_GET_OFFER, async (message) => {
      const response = await this.mediaHandler.handleMediaRequest(message.data);
      this.sendMediaResponse(message.id, SipWorker.MessageType.MEDIA_SESSION_READY, response);
    });

    this.on(SipWorker.MessageType.MEDIA_GET_ANSWER, async (message) => {
      const response = await this.mediaHandler.handleMediaRequest(message.data);
      this.sendMediaResponse(message.id, SipWorker.MessageType.MEDIA_SESSION_READY, response);
    });

    this.on(SipWorker.MessageType.MEDIA_SET_REMOTE_SDP, async (message) => {
      const response = await this.mediaHandler.handleMediaRequest(message.data);
      this.sendMediaResponse(message.id, SipWorker.MessageType.MEDIA_SESSION_READY, response);
    });

    // Xử lý WebRTC DTMF requests từ worker (preferred method)
    this.on(SipWorker.MessageType.DTMF_REQUEST_WEBRTC, async (message) => {
     
     
      console.log('Client received DTMF_REQUEST_WEBRTC message:', message);
      
      // Skip if this is not a proper DTMF request
      if (!message.data || typeof message.data !== 'object') {
        console.warn('Skipping invalid DTMF message - no valid data:', message);
        return;
      }

      // Check if this has the expected DTMF structure
      const data = message.data as any;
      if (!data.callId || !data.tones) {
        console.warn('Skipping DTMF message - missing callId or tones:', data);
        return;
      }

      try {
        console.log('Processing WebRTC DTMF:', data.tones, 'for call:', data.callId);
        
        // Handle DTMF request via WebRTC
        const response = await this.mediaHandler.handleDtmfRequest(data);
        console.log('WebRTC DTMF response:', response);
        
        // Send response back to worker
        const responseType = response.success ? 
          SipWorker.MessageType.DTMF_SENT : 
          SipWorker.MessageType.DTMF_FAILED;
        
        this.sendMessage({
          type: responseType,
          id: `dtmf-response-${message.id}`,
          tabId: this.tabId,
          timestamp: Date.now(),
          data: response
        });
      } catch (error: any) {
        console.error('Error handling WebRTC DTMF:', error);
        
        // Send error response
        this.sendMessage({
          type: SipWorker.MessageType.DTMF_FAILED,
          id: `dtmf-response-${message.id}`,
          tabId: this.tabId,
          timestamp: Date.now(),
          data: {
            callId: data.callId || 'unknown',
            success: false,
            tones: data.tones || '',
            error: error.message || 'WebRTC DTMF handling error'
          }
        });
      }
    });

    // Nhận DTMF responses để log kết quả
    this.on(SipWorker.MessageType.DTMF_SENT, (message) => {
      console.log('DTMF sent successfully:', message.data);
    });

    this.on(SipWorker.MessageType.DTMF_FAILED, (message) => {
      console.log('DTMF failed:', message.data);
    });

    // Xử lý call control requests từ worker
    this.on(SipWorker.MessageType.CALL_MUTE, async (message) => {
      console.log('Client received CALL_MUTE message:', message);
      console.log('Message data:', message.data);
      console.log('Message data type:', typeof message.data);
      console.log('Message data keys:', Object.keys(message.data || {}));
      
      // Check if this is a broadcast message (has callId and action) vs response message (has success)
      if (message.data && typeof message.data === 'object' && 'success' in message.data) {
        console.log('This is a CALL_MUTE response message, ignoring...');
        return;
      }
      
      // Fix: Extract callId correctly from message structure
      const callId = message.data?.callId;
      console.log('Extracted callId:', callId);
      if (!callId) {
        console.error('No callId found in CALL_MUTE message');
        console.error('Full message:', JSON.stringify(message, null, 2));
        return;
      }
      const result = await this.mediaHandler.muteAudio(callId);
      
      // Only send response if this tab actually processed the mute (has the session)
      if (result.success) {
        // Gửi response về worker
        this.sendMessage({
          type: SipWorker.MessageType.CALL_MUTED,
          id: `mute-response-${message.id}`,
          tabId: this.tabId,
          timestamp: Date.now(),
          data: {
            callId,
            success: result.success,
            action: 'mute',
            error: result.error
          }
        });
      } else {
        // Tab doesn't have this session - this is normal, just log quietly
        console.log('Tab does not own session for callId:', callId, '- ignoring mute request');
      }
    });

    this.on(SipWorker.MessageType.CALL_UNMUTE, async (message) => {
      console.log('Client received CALL_UNMUTE message:', message);
      console.log('Message data:', message.data);
      console.log('Message data type:', typeof message.data);
      console.log('Message data keys:', Object.keys(message.data || {}));
      
      // Check if this is a broadcast message (has callId and action) vs response message (has success)
      if (message.data && typeof message.data === 'object' && 'success' in message.data) {
        console.log('This is a CALL_UNMUTE response message, ignoring...');
        return;
      }
      
      // Fix: Extract callId correctly from message structure
      const callId = message.data?.callId;
      console.log('Extracted callId:', callId);
      if (!callId) {
        console.error('No callId found in CALL_UNMUTE message');
        console.error('Full message:', JSON.stringify(message, null, 2));
        return;
      }
      const result = await this.mediaHandler.unmuteAudio(callId);
      
      // Only send response if this tab actually processed the unmute (has the session)
      if (result.success) {
        // Gửi response về worker
        this.sendMessage({
          type: SipWorker.MessageType.CALL_UNMUTED,
          id: `unmute-response-${message.id}`,
          tabId: this.tabId,
          timestamp: Date.now(),
          data: {
            callId,
            success: result.success,
            action: 'unmute',
            error: result.error
          }
        });
      } else {
        // Tab doesn't have this session - this is normal, just log quietly
        console.log('Tab does not own session for callId:', callId, '- ignoring unmute request');
      }
    });

    // Xử lý call control responses
    this.on(SipWorker.MessageType.CALL_MUTED, (message) => {
      const response = message.data as SipWorker.CallControlResponse;
      console.log('Call muted:', response);
      
      // This is a response/broadcast message, not a request - do not process as mute request
      // Just log for UI sync
    });

    this.on(SipWorker.MessageType.CALL_UNMUTED, (message) => {
      const response = message.data as SipWorker.CallControlResponse;
      console.log('Call unmuted:', response);
      
      // This is a response/broadcast message, not a request - do not process as unmute request
      // Just log for UI sync
    });

    this.on(SipWorker.MessageType.CALL_HELD, (message) => {
      const response = message.data as SipWorker.CallControlResponse;
      console.log('Call held:', response);
    });

    this.on(SipWorker.MessageType.CALL_UNHELD, (message) => {
      const response = message.data as SipWorker.CallControlResponse;
      console.log('Call unheld:', response);
    });

    this.on(SipWorker.MessageType.CALL_TRANSFERRED, (message) => {
      const response = message.data as SipWorker.CallControlResponse;
      console.log('Call transferred:', response);
    });

    this.on(SipWorker.MessageType.CALL_TRANSFER_FAILED, (message) => {
      const response = message.data as SipWorker.CallControlResponse;
      console.log('Call transfer failed:', response);
    });

    // Xử lý worker ready
    this.on(SipWorker.MessageType.WORKER_READY, (message) => {
      this.connected = true;
      
      this.requestStateSync();
      
      setTimeout(() => {
        this.detectAndUpdateMediaPermission();
        this.setupTabStateTracking();
      }, 100); // Small delay to ensure worker is fully ready
    });

    // Xử lý PING từ worker để maintain connection
    this.on(SipWorker.MessageType.PING, (message) => {
      // Tự động phản hồi PONG
      this.sendMessage({
        type: SipWorker.MessageType.PONG,
        id: `pong-${message.id}`,
        tabId: this.tabId,
        timestamp: Date.now()
      });
    });

    // Xử lý call terminated để reset UI và cleanup session
    this.on(SipWorker.MessageType.CALL_TERMINATED, (message) => {
      const callData = message.data;
      let terminationInfo = 'Call terminated';
      
      if (callData.statusCode) {
        terminationInfo += ` - ${callData.statusCode}`;
        if (callData.reasonPhrase) {
          terminationInfo += ` ${callData.reasonPhrase}`;
        }
      } else if (callData.reason) {
        terminationInfo += ` - ${callData.reason}`;
      }
      
      console.log(terminationInfo, callData);
      
      // Fix: Cleanup session in MediaHandler when call terminates
      if (callData.id) {
        console.log(`Cleaning up session for terminated call: ${callData.id}`);
        this.mediaHandler.cleanupSession(callData.id);
      }
      
      // Event sẽ được forward đến demo HTML handlers
    });

  }

  /**
   * Gửi media response về worker
   */
  private sendMediaResponse(requestId: string, messageType: SipWorker.MessageType, response: SipWorker.MediaResponse): void {
    this.sendMessage({
      type: messageType,
      id: `response-${requestId}`, // Response ID để MessageBroker có thể match với request
      tabId: this.tabId,
      timestamp: Date.now(),
      data: response
    });
  }

  /**
   * Thiết lập theo dõi trạng thái tab
   */
  private setupTabStateTracking(): void {
    let debounceTimeout: number | null = null;
    let lastState: SipWorker.TabState | null = null;

    const updateTabState = () => {
      const newState = document.visibilityState === 'visible' ? 
        (document.hasFocus() ? SipWorker.TabState.ACTIVE : SipWorker.TabState.VISIBLE) : SipWorker.TabState.HIDDEN;

      if (newState !== lastState) {
        lastState = newState;
        
        this.sendMessage({
          type: SipWorker.MessageType.TAB_UPDATE_STATE,
          id: `update-state-${Date.now()}`,
          tabId: this.tabId,
          timestamp: Date.now(),
          data: {
            state: newState,
            lastActiveTime: newState === SipWorker.TabState.ACTIVE ? Date.now() : undefined
          }
        });

        if (lastState === SipWorker.TabState.HIDDEN
          && (newState === SipWorker.TabState.ACTIVE || newState === SipWorker.TabState.VISIBLE)) {
            this.requestStateSync();
        }
      }
    };

    const debouncedUpdate = () => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      debounceTimeout = setTimeout(updateTabState, 10) as any;
    };

    // Lắng nghe các sự kiện thay đổi trạng thái
    document.addEventListener('visibilitychange', debouncedUpdate);
    window.addEventListener('focus', debouncedUpdate);
    window.addEventListener('blur', debouncedUpdate);

    // Cleanup khi unload
    window.addEventListener('beforeunload', () => {
      this.sendMessage({
        type: SipWorker.MessageType.TAB_UNREGISTER,
        id: `unregister-${Date.now()}`,
        tabId: this.tabId,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Đăng ký message handler
   */
  public on(messageType: SipWorker.MessageType | string, handler: (message: SipWorker.Message) => void): void {
    const eventType = messageType as SipWorker.MessageType;
    if (!this.messageHandlers.has(eventType)) {
      this.messageHandlers.set(eventType, []);
    }
    this.messageHandlers.get(eventType)!.push(handler);
  }

  /**
   * Emit event to registered handlers
   */
  private emitEvent(eventType: string, message: SipWorker.Message): void {
    // Convert string event type to MessageType if needed
    const messageType = eventType as SipWorker.MessageType;
    const handlers = this.messageHandlers.get(messageType);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(message);
        } catch (error) {
          console.error('Error in event handler:', error);
        }
      });
    }
  }

  /**
   * Gửi tin nhắn đến worker
   */
  public sendMessage(message: SipWorker.Message): void {
    if (!this.port) {
      console.error('Worker port not available');
      return;
    }

    this.port.postMessage(message);
  }

  /**
   * Xử lý tin nhắn từ worker
   */
  private handleMessage(message: SipWorker.Message): void {
    console.log('Received message from worker:', message);

    // Handle STATE_SYNC specially to emit to UI handlers with string key
    if (message.type === SipWorker.MessageType.STATE_SYNC) {
      // Handle specific handlers (like getCurrentState)
      const specificHandlers = this.messageHandlers.get(message.type);
      if (specificHandlers) {
        specificHandlers.forEach(handler => {
          try {
            handler(message);
          } catch (error) {
            console.error('Error in specific handler:', error);
          }
        });
      }
      
      // Handle UI handlers with string key
      const uiHandlers = this.messageHandlers.get('state_sync' as SipWorker.MessageType);
      if (uiHandlers) {
        uiHandlers.forEach(handler => {
          try {
            handler(message);
          } catch (error) {
            console.error('Error in UI handler:', error);
          }
        });
      }
    } else {
      // Normal message handling for other types
      const handlers = this.messageHandlers.get(message.type);
      if (handlers) {
        handlers.forEach(handler => {
          try {
            handler(message);
          } catch (error) {
            console.error('Error in message handler:', error);
          }
        });
      }
    }
  }

  /**
   * Yêu cầu đăng ký SIP
   */
  public register(sipConfig: SipWorker.SipConfig, transportConfig: SipWorker.TransportConfig): void {
    // Update MediaHandler configuration with iceServers from transportConfig
    this.mediaHandler.updateConfiguration({
      iceServers: transportConfig.iceServers
    });
    
    this.sendMessage({
      type: SipWorker.MessageType.SIP_REGISTER,
      id: `register-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: { sipConfig, transportConfig }
    });
  }

  /**
   * Cập nhật cấu hình SIP
   */
  public updateConfig(config: SipWorker.SipUpdateConfigRequest): void {
    this.sendMessage({
      type: SipWorker.MessageType.SIP_UPDATE_CONFIG,
      id: `update-config-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: config
    });
  }

  /**
   * Hủy đăng ký SIP
   */
  public unregister(): void {
    this.sendMessage({
      type: SipWorker.MessageType.SIP_UNREGISTER,
      id: `unregister-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now()
    });
  }

  /**
   * Tạo cuộc gọi
   */
  public makeCall(targetUri: string, callId?: string, extraHeaders?: Record<string, string>): string {
    // Validate and generate callId
    const validatedCallId = this.validateAndGenerateCallId(callId);
    
    this.sendMessage({
      type: SipWorker.MessageType.CALL_MAKE,
      id: `make-call-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: { targetUri, callId: validatedCallId, extraHeaders }
    });
    
    return validatedCallId;
  }

  /**
   * Validate UUID and generate if needed
   */
  private validateAndGenerateCallId(callId?: string): string {
    if (!callId) {
      return uuidv7();
    }
    
    if (uuidValidate(callId)) {
      return callId;
    } else {
      console.warn(`Invalid callId format: ${callId}, generating new UUID`);
      return uuidv7();
    }
  }

  /**
   * Chấp nhận cuộc gọi đến
   */
  public answerCall(callId: string): void {
    this.sendMessage({
      type: SipWorker.MessageType.CALL_ANSWER,
      id: `answer-call-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: { callId }
    });
  }

  /**
   * Từ chối cuộc gọi đến
   */
  public rejectCall(callId: string, statusCode?: number, reasonPhrase?: string): void {
    this.sendMessage({
      type: SipWorker.MessageType.CALL_REJECT,
      id: `reject-call-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: { callId, statusCode, reasonPhrase }
    });
  }

  /**
   * Kết thúc cuộc gọi
   */
  public hangupCall(callId: string): void {
    this.sendMessage({
      type: SipWorker.MessageType.CALL_HANGUP,
      id: `hangup-call-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: { callId }
    });
  }

  /**
   * Gửi DTMF tones
   */
  public sendDtmf(callId: string, tones: string, duration?: number, interToneGap?: number): void {
    this.sendMessage({
      type: SipWorker.MessageType.DTMF_SEND,
      id: `dtmf-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: {
        callId,
        tones,
        duration,
        interToneGap
      } as SipWorker.DtmfRequest
    });
  }

  /**
   * Tắt tiếng cuộc gọi
   */
  public muteCall(callId: string): void {
    this.sendMessage({
      type: SipWorker.MessageType.CALL_MUTE,
      id: `mute-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: {
        callId,
        action: 'mute'
      } as SipWorker.CallControlRequest
    });
  }

  /**
   * Bật tiếng cuộc gọi
   */
  public unmuteCall(callId: string): void {
    this.sendMessage({
      type: SipWorker.MessageType.CALL_UNMUTE,
      id: `unmute-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: {
        callId,
        action: 'unmute'
      } as SipWorker.CallControlRequest
    });
  }

  /**
   * Giữ cuộc gọi
   */
  public holdCall(callId: string): void {
    this.sendMessage({
      type: SipWorker.MessageType.CALL_HOLD,
      id: `hold-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: {
        callId,
        action: 'hold'
      } as SipWorker.CallControlRequest
    });
  }

  /**
   * Bỏ giữ cuộc gọi
   */
  public unholdCall(callId: string): void {
    this.sendMessage({
      type: SipWorker.MessageType.CALL_UNHOLD,
      id: `unhold-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: {
        callId,
        action: 'unhold'
      } as SipWorker.CallControlRequest
    });
  }

  /**
   * Chuyển cuộc gọi
   */
  public transferCall(callId: string, targetUri: string, type: 'blind' | 'attended' = 'blind', extraHeaders?: Record<string, string>): void {
    this.sendMessage({
      type: SipWorker.MessageType.CALL_TRANSFER,
      id: `transfer-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: {
        callId,
        targetUri,
        type,
        extraHeaders
      } as SipWorker.CallTransferRequest
    });
  }

  /**
   * Yêu cầu đồng bộ trạng thái hiện tại từ worker
   */
  public requestStateSync(): void {
    this.sendMessage({
      type: SipWorker.MessageType.STATE_REQUEST,
      id: `state-request-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now()
    });
  }

  /**
   * Lấy trạng thái hiện tại (Promise-based)
   */
  public async getCurrentState(timeout: number = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = `state-request-${Date.now()}`;
      let timeoutId: number;

      // Setup timeout
      timeoutId = setTimeout(() => {
        this.off(SipWorker.MessageType.STATE_SYNC, stateHandler);
        reject(new Error('State request timeout'));
      }, timeout) as any;

      // Setup response handler
      const stateHandler = (message: SipWorker.Message) => {
        // CRITICAL FIX: Only respond to messages with matching requestId
        if (message.id.includes(requestId)) {
          clearTimeout(timeoutId);
          this.off(SipWorker.MessageType.STATE_SYNC, stateHandler);
          resolve(message.data);
        }
      };

      this.on(SipWorker.MessageType.STATE_SYNC, stateHandler);

      // Send request
      this.sendMessage({
        type: SipWorker.MessageType.STATE_REQUEST,
        id: requestId,
        tabId: this.tabId,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Bỏ đăng ký message handler
   */
  public off(messageType: SipWorker.MessageType, handler: (message: SipWorker.Message) => void): void {
    const handlers = this.messageHandlers.get(messageType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  /**
   * Cập nhật quyền media
   */
  public updateMediaPermission(permission: SipWorker.TabMediaPermission): void {
    this.sendMessage({
      type: SipWorker.MessageType.TAB_UPDATE_STATE,
      id: `update-media-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: { mediaPermission: permission }
    });
  }

  /**
   * Auto detect và update media permission
   */
  private async detectAndUpdateMediaPermission(): Promise<void> {
    try {
      // Try to get user media to detect permission
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      
      // If successful, permission is granted
      this.updateMediaPermission(SipWorker.TabMediaPermission.GRANTED);
      
      // Stop the stream immediately
      stream.getTracks().forEach(track => track.stop());
      
    } catch (error: any) {
      // Check error type to determine permission status
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        this.updateMediaPermission(SipWorker.TabMediaPermission.DENIED);
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        // No microphone found, but permission might be granted
        this.updateMediaPermission(SipWorker.TabMediaPermission.GRANTED);
      } else {
        // Other errors, assume not requested yet
        this.updateMediaPermission(SipWorker.TabMediaPermission.NOT_REQUESTED);
      }
    }
  }

  /**
   * Cleanup resources
   */
  public cleanup(): void {
    this.mediaHandler.cleanup();
    
    if (this.port) {
      this.port.close();
    }
    
    // Cleanup ServiceWorker resources
    if (this.notificationChannel) {
      this.notificationChannel.close();
      this.notificationChannel = null;
    }
    
    this.connected = false;
    console.log('SipWorkerClient cleaned up');
  }

  /**
   * Kiểm tra trạng thái kết nối
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Lấy tab ID
   */
  public getTabId(): string {
    return this.tabId;
  }
} 