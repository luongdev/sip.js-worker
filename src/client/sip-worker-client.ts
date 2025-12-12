import { SipWorker } from '../common/types';
import { MediaHandler, MediaHandlerCallbacks, MediaHandlerConfiguration } from './media-handler';
import { v7 as uuidv7, validate as uuidValidate } from 'uuid';
import {WorkerStateDto} from "../worker/worker-state.ts";

export interface SipWorkerClientOptions {
  tabId?: string;
  workerPath?: string;
  type?: ('classic' | 'module');
  /**
   * Enable automatic tab close protection (default: true)
   * Shows confirmation dialog when closing tab with active call
   */
  enableTabCloseProtection?: boolean;
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
  private audioContext: AudioContext | null = null;
  private audioContextStateChangeHandler: (() => void) | null = null;

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
      },
      getAudioContext: () => {
        return this.audioContext;
      },
      ensureAudioContextRunning: () => {
        return this.ensureAudioContextRunning();
      }
    };

    this.mediaHandler = new MediaHandler(mediaCallbacks, mediaOptions);

    // Khởi tạo SharedWorker
    this.initWorker(workerPath, type);

    // Đăng ký media handlers
    this.registerMediaHandlers();

    // Initialize AudioContext BEFORE worker connection to get correct initial state
    this.initializeAudioContext();

    // New: Khởi tạo ServiceWorker cho notifications
    this.initServiceWorkerNotifications();
    
    // Automatic tab close protection setup (enabled by default)
    if (options?.enableTabCloseProtection !== false) {
      this.setupAutomaticTabCloseProtection();
    }
  }
  
  /**
   * Setup automatic tab close protection
   * Enables protection and tracks call state automatically
   */
  private setupAutomaticTabCloseProtection(): void {
    // Enable protection
    this.enableTabCloseProtection();
    
    // Initialize flag
    (this as any)._hasActiveCall = false;
    
    // Track call state automatically
    this.on(SipWorker.MessageType.CALL_PROGRESS, (message) => {
      const callInfo = message.data;
      if (callInfo) {
        const isActive = callInfo.state === SipWorker.CallState.ESTABLISHED || 
                         callInfo.state === SipWorker.CallState.CONNECTING || 
                         callInfo.state === SipWorker.CallState.RINGING;
        
        (this as any)._hasActiveCall = isActive;
        
        if (isActive) {
          console.log(`Tab close protection ACTIVE (call ${callInfo.state})`);
        }
      }
    });
    
    // Clear flag when call ends
    this.on(SipWorker.MessageType.CALL_TERMINATED, () => {
      (this as any)._hasActiveCall = false;
      console.log('Tab close protection INACTIVE (call ended)');
    });
    
    console.log('Automatic tab close protection configured');
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
        '/assets/scripts/sw.js',
        { scope: '/assets/scripts/', updateViaCache: 'none' }
      );

      console.log('SIP Notifications ServiceWorker registered successfully');

      // FIX: Handle Service Worker lifecycle properly
      const installingWorker = this.serviceWorkerRegistration.installing;
      const waitingWorker = this.serviceWorkerRegistration.waiting;
      const activeWorker = this.serviceWorkerRegistration.active;

      // Handle installing worker
      if (installingWorker) {
        installingWorker.addEventListener('statechange', (event) => {
          const worker = event.target as ServiceWorker;
          console.log('SW installing state:', worker.state);

          if (worker.state === 'installed') {
            if (waitingWorker) {
              waitingWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          } else if (worker.state === 'activated') {
            this.setupServiceWorkerCommunication();
          }
        });
      }

      // Handle waiting worker
      if (waitingWorker) {
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      }

      // If already active, setup communication immediately
      if (activeWorker && !installingWorker && !waitingWorker) {
        this.setupServiceWorkerCommunication();
      }

      // Handle future updates as well
      this.serviceWorkerRegistration.addEventListener('updatefound', () => {
        const sw = this.serviceWorkerRegistration?.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && this.serviceWorkerRegistration?.waiting) {
            this.serviceWorkerRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
          if (sw.state === 'activated') {
            this.setupServiceWorkerCommunication();
          }
        });
      });

      // If controller appears later (when page is in scope), wire comms
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        this.setupServiceWorkerCommunication();
      });

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
   * Setup Service Worker communication after successful activation
   */
  private setupServiceWorkerCommunication(): void {
    console.log('Service Worker activated and ready');

    // Send registration confirmation to Service Worker
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'REGISTER_FOR_NOTIFICATIONS',
        tabId: this.tabId,
        timestamp: Date.now()
      });
    }

    // Start keep-alive mechanism to prevent Service Worker termination
    this.startServiceWorkerKeepAlive();
  }

  /**
   * Keep Service Worker alive by sending periodic pings
   */
  private startServiceWorkerKeepAlive(): void {
    // If host app injects an in-scope keepalive iframe, avoid duplicate pings
    if (document.getElementById('sip-sw-keepalive')) { return; }

    const pingOnly = () => {
      try {
        this.serviceWorkerRegistration?.active?.postMessage({
          type: 'KEEP_ALIVE',
          timestamp: Date.now()
        });
      } catch {}
    };

    const keepAliveInterval = setInterval(pingOnly, 25000);
    (this as any).keepAliveInterval = keepAliveInterval;
    setTimeout(pingOnly, 1000);
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
      case 'ACTIVATE_AUDIOCONTEXT':
        // Handle AudioContext activation request from notification
        this.handleAudioContextActivation();
        break;
      default:
        console.log('Unknown ServiceWorker message:', type);
    }
  }

  /**
   * Handle AudioContext activation request from service worker notification
   */
  private async handleAudioContextActivation(): Promise<void> {
    console.log('AudioContext activation requested from notification');
    
    try {
      // Ensure AudioContext is running
      const success = await this.ensureAudioContextRunning();
      
      if (success) {
        console.log('AudioContext successfully activated from notification');
        
        // Emit custom event for external handling
        const activationEvent = new CustomEvent('sipAudioContextActivated', {
          detail: { 
            success: true,
            source: 'notification',
            timestamp: Date.now()
          }
        });
        window.dispatchEvent(activationEvent);
        
        // Show user feedback (optional)
        if (typeof (window as any).onSipAudioContextActivated === 'function') {
          (window as any).onSipAudioContextActivated(true);
        }
      } else {
        console.warn('Failed to activate AudioContext from notification');
        
        // Emit failure event
        const activationEvent = new CustomEvent('sipAudioContextActivated', {
          detail: { 
            success: false,
            source: 'notification',
            error: 'Failed to activate AudioContext',
            timestamp: Date.now()
          }
        });
        window.dispatchEvent(activationEvent);
        
        // Show user feedback (optional)
        if (typeof (window as any).onSipAudioContextActivated === 'function') {
          (window as any).onSipAudioContextActivated(false);
        }
      }
    } catch (error) {
      console.error('Error activating AudioContext from notification:', error);
      
      // Emit error event
      const activationEvent = new CustomEvent('sipAudioContextActivated', {
        detail: { 
          success: false,
          source: 'notification',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: Date.now()
        }
      });
      window.dispatchEvent(activationEvent);
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
        handlingCall: false,
        audioContextRunning: this.getAudioContextState()
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
        // Report current AudioContext state now that worker is ready
        this.reportAudioContextState(this.getAudioContextState());
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

    // Cleanup on actual unload (not beforeunload)
    // beforeunload fires when dialog shows, but user might cancel
    // unload only fires when page actually closes
    window.addEventListener('unload', () => {
      this.sendMessage({
        type: SipWorker.MessageType.TAB_UNREGISTER,
        id: `unregister-${Date.now()}`,
        tabId: this.tabId,
        timestamp: Date.now()
      });
      
      // Cleanup AudioContext
      this.cleanupAudioContext();
    });
    
    // Re-register if page becomes visible again after close attempt
    // This handles the case where user cancels the close dialog
    let closeAttempted = false;
    window.addEventListener('beforeunload', () => {
      closeAttempted = true;
      // Check after a short delay if we're still here
      setTimeout(() => {
        if (closeAttempted && document.visibilityState === 'visible') {
          console.log('Tab close was cancelled - re-registering');
          closeAttempted = false;
          this.registerTab();
        }
      }, 50); // 50ms - very fast re-registration
    });
  }

  /**
   * Check if the current tab is handling media for any active call
   * @returns Promise<boolean> True if this tab is handling media for an active call
   */
  private async isHandlingMediaForActiveCall(): Promise<boolean> {
    try {
      // Get current state from worker
      const state = await this.getCurrentState(3000); // 3 second timeout

      if (!state || !state.activeCalls || !Array.isArray(state.activeCalls)) {
        return false;
      }

      // Check if any active call has this tab as the handling tab
      const activeCall = state.activeCalls.find(call =>
        call.handlingTabId === this.tabId &&
        (call.state === 'established' || call.state === 'connecting' || call.state === 'ringing')
      );

      return !!activeCall;
    } catch (error) {
      console.warn('Failed to check if tab is handling media:', error);
      return false; // Default to false to avoid blocking tab close
    }
  }

  /**
   * Public method to check if the current tab is handling media for any active call
   * @returns Promise<boolean> True if this tab is handling media for an active call
   */
  public async isHandlingMedia(): Promise<boolean> {
    return this.isHandlingMediaForActiveCall();
  }

  /**
   * Get information about the call being handled by this tab (if any)
   * @returns Promise<CallInfo | null> Call information or null if not handling any call
   */
  public async getHandledCallInfo(): Promise<SipWorker.CallInfo | null> {
    try {
      const state = await this.getCurrentState(3000);

      if (!state || !state.activeCalls || !Array.isArray(state.activeCalls)) {
        return null;
      }

      return state.activeCalls.find(call =>
        call.handlingTabId === this.tabId &&
        (call.state === 'established' || call.state === 'connecting' || call.state === 'ringing')
      ) || null;
    } catch (error) {
      console.warn('Failed to get handled call info:', error);
      return null;
    }
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
  public async getCurrentState(timeout: number = 5000): Promise<WorkerStateDto> {
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
   * Enable tab close protection - shows confirmation dialog when closing tab with active call
   * Call this method to enable the protection, typically after initializing the client
   */
  public enableTabCloseProtection(): void {
    // Prevent duplicate handlers
    if ((this as any).beforeUnloadHandler) {
      console.log('Tab close protection already enabled, skipping');
      return;
    }
    
    // Store reference to handler for cleanup
    const beforeUnloadHandler = (event: BeforeUnloadEvent): string | undefined => {
      console.log('beforeunload event triggered - checking for active call...');
      
      // IMPORTANT: beforeunload must be synchronous for the dialog to work
      // We can't use async/await here, so we check a cached state
      const hasActiveCall = (this as any)._hasActiveCall || false;
      
      console.log('Has active call (cached):', hasActiveCall);
      
      if (hasActiveCall) {
        const message = 'You have an active call. Closing this tab will end the call.';
        console.log('PREVENTING tab close - showing dialog');
        event.preventDefault();
        event.returnValue = message;
        return message;
      }
      
      console.log('No active call - allowing tab close');
      return undefined;
    };
    
    window.addEventListener('beforeunload', beforeUnloadHandler);
    (this as any).beforeUnloadHandler = beforeUnloadHandler;
    console.log('Tab close protection enabled');
  }

  /**
   * Disable tab close protection
   */
  public disableTabCloseProtection(): void {
    if ((this as any).beforeUnloadHandler) {
      window.removeEventListener('beforeunload', (this as any).beforeUnloadHandler);
      (this as any).beforeUnloadHandler = null;
      console.log('Tab close protection disabled');
    }
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
   * Get reconnection status
   * @returns Promise with reconnection status
   */
  public async getReconnectionStatus(): Promise<{
    isReconnecting: boolean;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
    reconnectDelay: number;
    currentDelay: number;
    maxReconnectDelay: number;
    backoffMultiplier: number;
  }> {
    return new Promise((resolve, reject) => {
      const requestId = `reconnection-status-${Date.now()}`;
      let timeoutId: number;

      // Setup timeout
      timeoutId = setTimeout(() => {
        this.off(SipWorker.MessageType.RECONNECTION_STATUS, statusHandler);
        reject(new Error('Reconnection status request timeout'));
      }, 5000) as any;

      // Setup response handler
      const statusHandler = (message: SipWorker.Message) => {
        if (message.id.includes(requestId)) {
          clearTimeout(timeoutId);
          this.off(SipWorker.MessageType.RECONNECTION_STATUS, statusHandler);
          resolve(message.data);
        }
      };

      this.on(SipWorker.MessageType.RECONNECTION_STATUS, statusHandler);

      // Send request
      this.sendMessage({
        type: SipWorker.MessageType.RECONNECTION_STATUS,
        id: requestId,
        tabId: this.tabId,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Manually trigger reconnection
   * @returns Promise with reconnection result
   */
  public async triggerReconnection(): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
      const requestId = `reconnection-trigger-${Date.now()}`;
      let timeoutId: number;

      // Setup timeout
      timeoutId = setTimeout(() => {
        this.off(SipWorker.MessageType.RECONNECTION_TRIGGER, triggerHandler);
        reject(new Error('Reconnection trigger timeout'));
      }, 10000) as any;

      // Setup response handler
      const triggerHandler = (message: SipWorker.Message) => {
        if (message.id.includes(requestId)) {
          clearTimeout(timeoutId);
          this.off(SipWorker.MessageType.RECONNECTION_TRIGGER, triggerHandler);
          resolve(message.data);
        }
      };

      this.on(SipWorker.MessageType.RECONNECTION_TRIGGER, triggerHandler);

      // Send request
      this.sendMessage({
        type: SipWorker.MessageType.RECONNECTION_TRIGGER,
        id: requestId,
        tabId: this.tabId,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Configure reconnection settings
   * @param config Reconnection configuration
   * @returns Promise with configuration result
   */
  public async configureReconnection(config: {
    maxAttempts?: number;
    delay?: number;
    maxDelay?: number;
    backoffMultiplier?: number;
  }): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
      const requestId = `reconnection-config-${Date.now()}`;
      let timeoutId: number;

      // Setup timeout
      timeoutId = setTimeout(() => {
        this.off(SipWorker.MessageType.RECONNECTION_CONFIG, configHandler);
        reject(new Error('Reconnection config timeout'));
      }, 5000) as any;

      // Setup response handler
      const configHandler = (message: SipWorker.Message) => {
        if (message.id.includes(requestId)) {
          clearTimeout(timeoutId);
          this.off(SipWorker.MessageType.RECONNECTION_CONFIG, configHandler);
          resolve(message.data);
        }
      };

      this.on(SipWorker.MessageType.RECONNECTION_CONFIG, configHandler);

      // Send request
      this.sendMessage({
        type: SipWorker.MessageType.RECONNECTION_CONFIG,
        id: requestId,
        tabId: this.tabId,
        timestamp: Date.now(),
        data: config
      });
    });
  }

  /**
   * Get current AudioContext state
   * @returns boolean indicating if AudioContext is running
   */
  private getAudioContextState(): boolean {
    if (!this.audioContext) {
      return false;
    }
    return this.audioContext.state === 'running';
  }

  /**
   * Initialize AudioContext and setup state tracking
   */
  private initializeAudioContext(): void {
    try {
      // Create AudioContext if it doesn't exist
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        console.log('AudioContext created, initial state:', this.audioContext.state);
      }

      // Setup state change listener
      if (!this.audioContextStateChangeHandler) {
        this.audioContextStateChangeHandler = () => {
          const isRunning = this.getAudioContextState();
          console.log('AudioContext state changed:', this.audioContext?.state, 'running:', isRunning);
          this.reportAudioContextState(isRunning);
        };

        this.audioContext.addEventListener('statechange', this.audioContextStateChangeHandler);
      }

      // Report initial state
      this.reportAudioContextState(this.getAudioContextState());
    } catch (error) {
      console.warn('Failed to initialize AudioContext:', error);
      this.reportAudioContextState(false);
    }
  }

  /**
   * Report AudioContext state to worker
   * @param isRunning Whether AudioContext is running
   */
  private reportAudioContextState(isRunning: boolean): void {
    if (!this.connected) {
      console.log(`AudioContext state ready to report: ${isRunning} (waiting for worker connection)`);
      return; // Don't send if not connected to worker
    }

    console.log(`Reporting AudioContext state to worker: ${isRunning}`);
    this.sendMessage({
      type: SipWorker.MessageType.TAB_UPDATE_AUDIO_CONTEXT,
      id: `audio-context-${Date.now()}`,
      tabId: this.tabId,
      timestamp: Date.now(),
      data: {
        audioContextRunning: isRunning
      }
    });
  }

  /**
   * Ensure AudioContext is running (resume if suspended)
   * This is typically called when starting media operations
   */
  public async ensureAudioContextRunning(): Promise<boolean> {
    try {
      if (!this.audioContext) {
        this.initializeAudioContext();
      }

      if (this.audioContext && this.audioContext.state === 'suspended') {
        console.log('Resuming suspended AudioContext...');
        await this.audioContext.resume();
        console.log('AudioContext resumed, state:', this.audioContext.state);
      }

      const isRunning = this.getAudioContextState();
      this.reportAudioContextState(isRunning);
      return isRunning;
    } catch (error) {
      console.error('Failed to ensure AudioContext is running:', error);
      this.reportAudioContextState(false);
      return false;
    }
  }

  /**
   * Get AudioContext instance (create if needed)
   * @returns AudioContext instance or null if creation failed
   */
  public getAudioContext(): AudioContext | null {
    if (!this.audioContext) {
      this.initializeAudioContext();
    }
    return this.audioContext;
  }

  /**
   * Cleanup AudioContext resources
   */
  private cleanupAudioContext(): void {
    if (this.audioContext && this.audioContextStateChangeHandler) {
      this.audioContext.removeEventListener('statechange', this.audioContextStateChangeHandler);
      this.audioContextStateChangeHandler = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(error => {
        console.warn('Error closing AudioContext:', error);
      });
    }

    this.audioContext = null;
  }

  /**
   * Cleanup client resources
   */
  public cleanup(): void {
    // Cleanup MediaHandler
    this.mediaHandler.cleanup();
    
    // Cleanup AudioContext
    this.cleanupAudioContext();
    
    // Clear keepalive interval
    if ((this as any).keepAliveInterval) {
      clearInterval((this as any).keepAliveInterval);
      (this as any).keepAliveInterval = null;
      console.log('Service Worker keep-alive interval cleared');
    }
    
    // Close notification channel
    if (this.notificationChannel) {
      this.notificationChannel.close();
      this.notificationChannel = null;
    }
    
    // Close worker port
    if (this.port) {
      this.port.close();
      this.port = null;
    }
    
    // Cleanup tab close protection
    this.disableTabCloseProtection();
    
    this.connected = false;
    console.log('SipWorkerClient cleanup completed');
  }
}
