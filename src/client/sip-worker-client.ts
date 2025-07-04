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
    this.initWorker(workerPath);
    
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

    // this.on(SipWorker.MessageType.MEDIA_ICE_CANDIDATE, async (message) => {
    //   console.log('MEDIA_ICE_CANDIDATE handler - message:', message);
    //   console.log('MEDIA_ICE_CANDIDATE handler - message.data:', message.data);
    //   const response = await this.mediaHandler.handleMediaRequest(message.data);
    //   this.sendMediaResponse(message.id, SipWorker.MessageType.MEDIA_SESSION_READY, response);
    // });

    // Xử lý worker ready
    this.on(SipWorker.MessageType.WORKER_READY, (message) => {
      this.connected = true;
      console.log('Connected to worker');
      
      // Auto request state sync when connected
      setTimeout(() => {
        this.requestStateSync();
        // Also detect and update media permission
        this.detectAndUpdateMediaPermission();
      }, 100); // Small delay to ensure worker is fully ready
    });

    // Xử lý state sync từ worker
    this.on(SipWorker.MessageType.STATE_SYNC, (message) => {
      console.log('Received state sync from worker:', message.data);
      // Forward state to any listeners
      this.handleStateSync(message.data);
    });

    // Xử lý state changed từ worker
    this.on(SipWorker.MessageType.STATE_CHANGED, (message) => {
      console.log('Worker state changed:', message.data);
      // Forward state change to any listeners
      this.handleStateChange(message.data);
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

    // Cập nhật trạng thái tab khi visibility thay đổi
    this.setupTabStateTracking();
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
  public on(messageType: SipWorker.MessageType, handler: (message: SipWorker.Message) => void): void {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, []);
    }
    this.messageHandlers.get(messageType)!.push(handler);
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
        if (message.id.includes(requestId) || message.type === SipWorker.MessageType.STATE_SYNC) {
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

  /**
   * Handle state sync from worker
   */
  private handleStateSync(state: any): void {
    // Update UI based on synced state
    if (state.sipRegistration?.registered) {
      console.log('SIP is registered:', state.sipRegistration);
    }
    
    if (state.activeCalls?.length > 0) {
      console.log('Active calls:', state.activeCalls);
      // Update UI for each active call
      state.activeCalls.forEach((call: any) => {
        this.updateCallUI(call);
      });
    }
  }

  /**
   * Handle state change from worker
   */
  private handleStateChange(state: any): void {
    // Similar to handleStateSync but for incremental updates
    this.handleStateSync(state);
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