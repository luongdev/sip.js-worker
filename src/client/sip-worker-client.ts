import { SipWorker } from '../common/types';
import { MediaHandler, MediaHandlerCallbacks } from './media-handler';

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

  /**
   * Khởi tạo SipWorkerClient
   * @param workerPath Đường dẫn đến worker script
   * @param tabId ID của tab (optional, sẽ tự tạo nếu không có)
   */
  constructor(tabId?: string, workerPath?: string, type?: ('classic' | 'module')) {
    this.tabId = tabId || `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Tạo callbacks cho MediaHandler
    const mediaCallbacks: MediaHandlerCallbacks = {
      sendIceCandidate: (sessionId: string, candidate: RTCIceCandidate) => {
        this.sendMessage({
          type: SipWorker.MessageType.MEDIA_ICE_CANDIDATE,
          id: `ice-candidate-${Date.now()}`,
          tabId: this.tabId,
          timestamp: Date.now(),
          data: {
            sessionId,
            success: true,
            candidate: candidate.toJSON()
          }
        });
      },
      sendSessionReady: (sessionId: string) => {
        this.sendMessage({
          type: SipWorker.MessageType.MEDIA_SESSION_READY,
          id: `session-ready-${Date.now()}`,
          tabId: this.tabId,
          timestamp: Date.now(),
          data: {
            sessionId,
            success: true
          }
        });
      },
      sendSessionFailed: (sessionId: string, error: string) => {
        this.sendMessage({
          type: SipWorker.MessageType.MEDIA_SESSION_FAILED,
          id: `session-failed-${Date.now()}`,
          tabId: this.tabId,
          timestamp: Date.now(),
          data: {
            sessionId,
            success: false,
            error
          }
        });
      },
      handleRemoteStream: (sessionId: string, stream: MediaStream) => {
        console.log('Received remote stream for session:', sessionId);
        
        // Tìm remote audio element và set stream
        const remoteAudio = document.getElementById('remote-audio') as HTMLAudioElement;
        if (remoteAudio) {
          remoteAudio.srcObject = stream;
          console.log('Remote audio stream set successfully');
        } else {
          console.warn('Remote audio element not found');
        }
        
        // Có thể emit event hoặc gọi callback từ bên ngoài nếu cần
      }
    };
    
    this.mediaHandler = new MediaHandler(mediaCallbacks);
    
    // Khởi tạo SharedWorker
    this.initWorker(workerPath, type);
    
    // Đăng ký media handlers
    this.registerMediaHandlers();
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
      };

      this.worker.onerror = (error) => {
        console.error('SharedWorker error:', error);
      };

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

    // Xử lý DTMF requests từ worker
    this.on(SipWorker.MessageType.DTMF_SEND, async (message) => {
      const response = await this.mediaHandler.handleDtmfRequest(message.data);
      // Gửi response về worker với message type tương ứng
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

    // Xử lý call terminated để reset UI
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
        (document.hasFocus() ? SipWorker.TabState.ACTIVE : SipWorker.TabState.VISIBLE) : 
        SipWorker.TabState.HIDDEN;

      if (newState !== lastState) {
        lastState = newState;
        
        // Update tab state
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

        // Request fresh state when tab becomes visible/active (from hidden state)
        if ((newState === SipWorker.TabState.ACTIVE || newState === SipWorker.TabState.VISIBLE) && 
            lastState === SipWorker.TabState.HIDDEN) {
          setTimeout(() => {
            this.requestStateSync();
          }, 100); // Small delay to ensure tab state is updated first
        }
      }
    };

    const debouncedUpdate = () => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      debounceTimeout = setTimeout(updateTabState, 50) as any;
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
    this.sendMessage({
      type: SipWorker.MessageType.SIP_REGISTER,
      id: `register-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: { sipConfig, transportConfig }
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
  public makeCall(targetUri: string, extraHeaders?: Record<string, string>): void {
    this.sendMessage({
      type: SipWorker.MessageType.CALL_MAKE,
      id: `make-call-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: { targetUri, extraHeaders }
    });
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
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

  // handleStateSync method removed to prevent infinite loops
  // STATE_SYNC messages are handled by specific handlers only

  /**
   * Handle state change from worker
   */
  private handleStateChange(state: any): void {
    console.log('Received state change from worker:', state);
    
    // Emit state_sync event for UI to handle (reuse same handler)
    const handlers = this.messageHandlers.get(SipWorker.MessageType.STATE_SYNC);
    if (handlers) {
      const message: SipWorker.Message = {
        type: SipWorker.MessageType.STATE_SYNC,
        id: `state-change-${Date.now()}`,
        tabId: this.tabId,
        timestamp: Date.now(),
        data: state
      };
      
      handlers.forEach(handler => {
        try {
          handler(message);
        } catch (error) {
          console.error('Error in state change handler:', error);
        }
      });
    }
  }

  /**
   * Update UI for a specific call
   */
  private updateCallUI(call: any): void {
    // This will be implemented based on your UI framework
    console.log('Updating UI for call:', call);
    
    // Example: trigger events for UI components to handle
    if (call.state === 'ringing' && call.direction === 'incoming') {
      // Show incoming call UI
      console.log('Show incoming call UI for:', call.id);
    } else if (call.state === 'established') {
      // Show established call UI
      console.log('Show established call UI for:', call.id);
    }
  }
} 