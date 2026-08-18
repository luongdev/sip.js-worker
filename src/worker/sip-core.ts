/**
 * SipCore - Lớp xử lý SIP signaling
 */

import { SipWorker } from '../common/types';
import { MessageBroker } from './message-broker';
import { TabManager } from './tab-manager';
import {
  createWorkerSessionDescriptionHandlerFactory,
  WorkerSessionDescriptionHandlerOptions,
} from './worker-session-description-handler';
import {
  UserAgent,
  UserAgentOptions,
  Registerer,
  RegistererState,
  Inviter,
  Invitation,
  Session,
  SessionState,
  Web,
  InviterOptions
} from 'sip.js';
import { v7 as uuidv7 } from 'uuid';
import { WorkerState } from './worker-state';
import { LenientTransport } from './lenient-transport';

// Định nghĩa LogLevel theo đúng định nghĩa từ sip.js
type LogLevel = "debug" | "log" | "warn" | "error";

/**
 * Interface cho tùy chọn khởi tạo SipCore
 */
export interface SipCoreOptions {
  /**
   * Cấu hình SIP
   */
  sipConfig: SipWorker.SipConfig;

  /**
   * Cấu hình transport
   */
  transportConfig: SipWorker.TransportConfig;

  /**
   * Cấu hình log
   */
  logConfig?: SipWorker.LogConfig;

  /**
   * Thời gian timeout cho các yêu cầu (ms)
   */
  requestTimeout?: number;

  /**
   * Có tự động đăng ký SIP khi khởi tạo không
   */
  autoRegister?: boolean;

  /**
   * Có tự động chấp nhận cuộc gọi đến thông thường không
   */
  autoAcceptInboundCalls?: boolean;

  /**
   * Có tự động chấp nhận cuộc gọi predict không
   */
  autoAcceptPredictCalls?: boolean;
}

/**
 * Interface cho thông tin đăng nhập SIP
 */
export interface SipCredentials {
  /**
   * URI của SIP server
   */
  uri?: string;

  /**
   * Tên người dùng SIP
   */
  username?: string;

  /**
   * Mật khẩu SIP
   */
  password?: string;

  /**
   * Tên hiển thị
   */
  displayName?: string;
}

/**
 * Lớp SipCore xử lý SIP signaling
 */
export class SipCore {
  /**
   * UserAgent của SIP.js
   */
  private userAgent: UserAgent | null = null;

  /**
   * Registerer của SIP.js
   */
  private registerer: Registerer | null = null;

  /**
   * MessageBroker để giao tiếp với các tab
   */
  private messageBroker: MessageBroker;

  /**
   * TabManager để quản lý các tab
   */
  private tabManager: TabManager;

  /**
   * Cấu hình SIP
   */
  private sipConfig: SipWorker.SipConfig;

  /**
   * Cấu hình transport
   */
  private transportConfig: SipWorker.TransportConfig;

  /**
   * Cấu hình log
   */
  private logConfig: SipWorker.LogConfig;

  /**
   * Thời gian timeout cho các yêu cầu (ms)
   */
  private requestTimeout: number;

  /**
   * Có tự động đăng ký SIP khi khởi tạo không
   */
  private autoRegister: boolean;

  /**
   * Có tự động chấp nhận cuộc gọi đến thông thường không
   */
  private autoAcceptInboundCalls: boolean;

  /**
   * Có tự động chấp nhận cuộc gọi predict không
   */
  private autoAcceptPredictCalls: boolean;



  /**
   * Variable name in X-Extra header to identify predict calls
   */
  private predictCallExtraVariable: string;

  /**
   * Trạng thái đăng ký SIP
   */
  private registered: boolean = false;

  /**
   * Danh sách các cuộc gọi đang diễn ra
   */
  private activeCalls: Map<string, Session> = new Map();

  /**
   * Danh sách các cuộc gọi đang chờ auto-accept
   */
  private pendingAutoAcceptCalls: Map<string, boolean> = new Map();

  /**
   * Clean up call from all tracking maps
   */
  private cleanupCall(callId: string): void {
    this.activeCalls.delete(callId);
    this.pendingAutoAcceptCalls.delete(callId);
  }





  /**
   * Reconnection state
   */
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = Infinity; // Unlimited retries
  private reconnectDelay: number = 10000; // 10 seconds initial delay
  private maxReconnectDelay: number = 60000; // 60 seconds max delay
  private backoffMultiplier: number = 1.3;
  private reconnectTimer: number | null = null;
  private isReconnecting: boolean = false;
  private currentDelay: number = 10000; // Track current delay for backoff

  /**
   * Custom re-registration state
   */
  private customRefreshTimer: number | null = null;
  private actualExpiresTime: number = 0; // Actual expires from server response
  private useCustomRefresh: boolean = false;
  private customRefreshFailures: number = 0; // Track consecutive failures
  private maxCustomRefreshFailures: number = 3; // Max failures before fallback

  /**
   * BroadcastChannel for ServiceWorker notifications
   */
  private notificationChannel: BroadcastChannel | null = null;

  /**
   * Last AudioContext notification timestamp (to prevent spam)
   */
  private lastAudioContextNotification: number = 0;
  private audioContextNotificationCooldown: number = 30000; // 30 seconds

  /**
   * AudioContext notification delay mechanism
   * Prevents notifications for brief suspensions that quickly resume
   */
  private audioContextNotificationTimer: NodeJS.Timeout | null = null;
  private audioContextNotificationDelay: number = 2000; // 2 seconds delay

  constructor(
    messageBroker: MessageBroker,
    tabManager: TabManager,
    options: SipCoreOptions,
    private workerState?: WorkerState // Import sau
  ) {
    this.messageBroker = messageBroker;
    this.tabManager = tabManager;
    this.sipConfig = options.sipConfig;
    this.transportConfig = options.transportConfig;
    this.logConfig = options.logConfig || {
      level: 'info',
      sendToClient: true,
      console: true
    };
    this.requestTimeout = options.requestTimeout || 30000;
    this.autoRegister = options.autoRegister !== undefined ? options.autoRegister : true;
    this.autoAcceptInboundCalls = options.autoAcceptInboundCalls !== undefined ? options.autoAcceptInboundCalls : false;
    this.autoAcceptPredictCalls = options.autoAcceptPredictCalls !== undefined ? options.autoAcceptPredictCalls : false;
    this.predictCallExtraVariable = options.sipConfig.predictCallExtraVariable || 'extra_interact_card_id';

    // Initialize BroadcastChannel for ServiceWorker notifications
    try {
      this.notificationChannel = new BroadcastChannel('sip-notifications');
      this.log('info', 'BroadcastChannel initialized for ServiceWorker notifications');

      // Listen for notification actions from ServiceWorker
      this.notificationChannel.addEventListener('message', (event) => {
        const { type } = event.data;

        if (type === 'SW_NOTIFICATION_ACTION') {
          this.handleNotificationAction(event.data).catch(err => {
            this.log('error', `Error handling notification action: ${err.message}`);
          });
        } else if (type === 'REQUEST_STATE_SYNC') {
          this.log('info', `ServiceWorker requested state sync: ${event.data.reason}`);
          this.messageBroker.broadcast({
            type: SipWorker.MessageType.STATE_SYNC,
            id: `state-sync-sw-${Date.now()}`,
            timestamp: Date.now(),
            data: this.workerState?.getSerializableState() || {}
          });
        }
      });
    } catch (error) {
      this.log('warn', `Failed to initialize BroadcastChannel: ${error}`);
      this.notificationChannel = null;
    }

    // Đăng ký các handler xử lý tin nhắn
    this.registerMessageHandlers();

    // Khởi tạo UserAgent
    this.initUserAgent();

    // Tự động đăng ký nếu cần
    if (this.autoRegister) {
      this.register();
    }
  }

  /**
   * Chuyển đổi log level từ cấu hình sang LogLevel
   * @returns LogLevel string
   */
  private getLogLevel(): LogLevel {
    switch (this.logConfig.level) {
      case 'debug':
        return 'debug';
      case 'info':
        return 'log';
      case 'warn':
        return 'warn';
      case 'error':
        return 'error';
      case 'none':
        return 'error'; // SIP.js không có None, dùng Error và không gửi log
      default:
        return 'log';
    }
  }

  /**
   * Gửi log về client
   * @param level Level của log
   * @param message Nội dung log
   */
  private sendLogToClient(level: string, message: string): void {
    // Nếu không cần gửi log về client, không làm gì cả
    if (!this.logConfig.sendToClient) {
      return;
    }

    // Gửi log về tất cả các tab
    this.messageBroker.broadcast({
      type: SipWorker.MessageType.LOG,
      id: `log-${Date.now()}`,
      timestamp: Date.now(),
      data: {
        level,
        message: `[SIP] ${message}`
      }
    });
  }

  /**
   * Đăng ký các handler xử lý tin nhắn
   * Note: SIP message handlers được xử lý bởi worker/index.ts,
   * SipCore chỉ expose public methods để worker gọi
   */
  private registerMessageHandlers(): void {
    // SipCore không đăng ký handlers để tránh duplicate với worker
    // Các handlers SIP được xử lý trong worker/index.ts
  }

  /**
   * Cập nhật thông tin đăng nhập SIP mà không tạo lại UserAgent
   * @param credentials Thông tin đăng nhập mới
   */
  public updateCredentials(credentials: SipCredentials): void {
    if (!this.userAgent) {
      this.log('error', 'Cannot update credentials: UserAgent not initialized');
      return;
    }

    // 1. Cập nhật thông tin trong sipConfig
    if (credentials.username !== undefined) {
      this.sipConfig.username = credentials.username;
    }
    if (credentials.password !== undefined) {
      this.sipConfig.password = credentials.password;
    }
    if (credentials.displayName !== undefined) {
      this.sipConfig.displayName = credentials.displayName;
    }
    if (credentials.uri !== undefined) {
      this.sipConfig.uri = credentials.uri;
    }

    // 2. Hack: Cập nhật trực tiếp các thuộc tính của UserAgent
    // @ts-ignore - Truy cập thuộc tính private
    if (this.userAgent.options) {
      // @ts-ignore - Truy cập thuộc tính private
      if (credentials.username !== undefined) {
        // @ts-ignore - Truy cập thuộc tính private
        this.userAgent.options.authorizationUsername = credentials.username;
      }
      // @ts-ignore - Truy cập thuộc tính private
      if (credentials.password !== undefined) {
        // @ts-ignore - Truy cập thuộc tính private
        this.userAgent.options.authorizationPassword = credentials.password;
      }
      // @ts-ignore - Truy cập thuộc tính private
      if (credentials.displayName !== undefined) {
        // @ts-ignore - Truy cập thuộc tính private
        this.userAgent.options.displayName = credentials.displayName;
      }
    }

    // 3. Hack: Ghi đè authenticationFactory để sử dụng thông tin đăng nhập mới
    // @ts-ignore - Truy cập thuộc tính private
    if (this.userAgent.userAgentCore && this.userAgent.userAgentCore.configuration) {
      // @ts-ignore - Truy cập thuộc tính private
      const originalAuthFactory = this.userAgent.userAgentCore.configuration.authenticationFactory;

      // @ts-ignore - Truy cập thuộc tính private
      this.userAgent.userAgentCore.configuration.authenticationFactory = () => {
        // Gọi hàm gốc để tạo đối tượng DigestAuthentication
        const digestAuth = originalAuthFactory();

        // Nếu có thông tin đăng nhập mới, cập nhật trực tiếp vào đối tượng
        if (digestAuth) {
          // @ts-ignore - Truy cập thuộc tính private
          if (credentials.username !== undefined) {
            // @ts-ignore - Truy cập thuộc tính private
            digestAuth.username = credentials.username;
          }
          // @ts-ignore - Truy cập thuộc tính private
          if (credentials.password !== undefined) {
            // @ts-ignore - Truy cập thuộc tính private
            digestAuth.password = credentials.password;
          }
        }

        return digestAuth;
      };
    }

    this.log('info', `Credentials updated: username=${this.sipConfig.username}, displayName=${this.sipConfig.displayName}`);

    // Note: Auto re-register đã được xóa để tránh loop
    // Worker sẽ tự quyết định khi nào re-register dựa trên user action
  }

  /**
   * Cập nhật cấu hình SIP
   * @param config Cấu hình mới
   */
  public updateConfig(config: {
    autoAcceptInboundCalls?: boolean;
    autoAcceptPredictCalls?: boolean;
    predictCallExtraVariable?: string;
  }): void {
    if (config.autoAcceptInboundCalls !== undefined) {
      this.autoAcceptInboundCalls = config.autoAcceptInboundCalls;
      this.log('info', `Auto accept inbound calls updated: ${this.autoAcceptInboundCalls}`);
    }
    if (config.autoAcceptPredictCalls !== undefined) {
      this.autoAcceptPredictCalls = config.autoAcceptPredictCalls;
      this.log('info', `Auto accept predict calls updated: ${this.autoAcceptPredictCalls}`);
    }
    if (config.predictCallExtraVariable !== undefined) {
      this.predictCallExtraVariable = config.predictCallExtraVariable;
      this.log('info', `Predict call extra variable updated: ${this.predictCallExtraVariable}`);
    }
  }

  /**
   * Khởi tạo UserAgent
   */
  private initUserAgent(): void {
    try {
      this.log('info', `Initializing UserAgent with URI: ${this.sipConfig.uri}`);
      this.log('info', `Transport server: ${this.transportConfig.server}`);
      this.log('info', `Transport secure: ${this.transportConfig.secure}`);
      this.log('info', `Transport reconnection timeout: ${this.transportConfig.reconnectionTimeout}`);

      // Tạo URI
      const uri = UserAgent.makeURI(this.sipConfig.uri);
      if (!uri) {
        throw new Error(`Invalid SIP URI: ${this.sipConfig.uri}`);
      }

      // Tạo cấu hình transport
      const transportOptions: Web.TransportOptions = {
        server: this.transportConfig.server,
        connectionTimeout: this.transportConfig.reconnectionTimeout
        // Không sử dụng maxReconnectionAttempts vì không được hỗ trợ
      };

      this.log('info', `Transport options: ${JSON.stringify(transportOptions)}`);

      // Tạo WorkerSessionDescriptionHandlerFactory
      const sessionDescriptionHandlerFactory = createWorkerSessionDescriptionHandlerFactory(
        this.messageBroker,
        this.tabManager,
        this.workerState
      );

      // Tạo cấu hình UserAgent
      const userAgentOptions: UserAgentOptions = {
        uri,
        transportOptions,
        transportConstructor: LenientTransport,
        authorizationUsername: this.sipConfig.username,
        authorizationPassword: this.sipConfig.password,
        displayName: this.sipConfig.displayName,
        logBuiltinEnabled: this.logConfig.console,
        logLevel: this.getLogLevel(),
        viaHost: uri.host,
        contactName: this.sipConfig.username,
        sessionDescriptionHandlerFactory,
        ...this.sipConfig.sipOptions
      };

      this.log('info', `UserAgent options created successfully`);

      // Tạo UserAgent
      this.userAgent = new UserAgent(userAgentOptions);

      // Thiết lập các sự kiện
      this.setupUserAgentListeners();

      // UserAgent sẽ được start trong register() method
      this.log('info', 'UserAgent initialized successfully');
    } catch (error: any) {
      this.log('error', `Failed to initialize UserAgent: ${error.message}`);
      this.log('error', `Error stack: ${error.stack}`);
    }
  }

  /**
   * Thiết lập các listener cho UserAgent
   */
  private setupUserAgentListeners(): void {
    if (!this.userAgent) {
      return;
    }

    // Sự kiện khi UserAgent được khởi động
    this.userAgent.delegate = {
      onConnect: () => {
        this.log('info', 'UserAgent connected');
        // Reset reconnection attempts on successful connection
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
      },
      onDisconnect: (error) => {
        this.log('warn', `UserAgent disconnected: ${error ? error.message : 'Unknown reason'}`);
        if (error) {
          this.log('error', `Disconnect error details: ${JSON.stringify(error)}`);
        }

        // Trigger automatic reconnection for UserAgent disconnect
        this.handleTransportDisconnect();
      },
      onInvite: (invitation) => {
        this.handleIncomingCall(invitation).catch(err => {
          this.log('error', `Error handling incoming call: ${err.message}`);
        });
      }
    };

    // Lắng nghe transport events
    this.userAgent.transport.stateChange.addListener((state) => {
      this.log('info', `Transport state changed to: ${state}`);

      // Log additional details for specific states
      switch (state) {
        case 'Connecting':
          this.log('info', 'Transport attempting to connect...');
          break;
        case 'Connected':
          this.log('info', 'Transport connected successfully');
          break;
        case 'Disconnected':
          this.log('warn', 'Transport disconnected');
          break;
        default:
          this.log('info', `Transport state: ${state}`);
          break;
      }
    });

    this.userAgent.transport.onConnect = () => {
      this.log('info', 'Transport connected successfully');
    };

    this.userAgent.transport.onDisconnect = (error) => {
      this.log('error', `Transport disconnected: ${error ? error.message : 'Unknown reason'}`);
      if (error) {
        this.log('error', `Transport disconnect error details: ${JSON.stringify(error)}`);
      }

      // Trigger automatic reconnection
      this.handleTransportDisconnect();
    };
  }

  /**
   * Handle notification actions from ServiceWorker
   */
  private async handleNotificationAction(data: any): Promise<void> {
    const { type, action, callId } = data;

    if (type === 'SW_NOTIFICATION_ACTION') {
      this.log('info', `ServiceWorker notification action received: ${action} for call ${callId}`);

      switch (action) {
        case 'answer':
          await this.acceptCall(callId);
          break;
        case 'reject':
          await this.rejectCall(callId);
          break;
        default:
          this.log('warn', `Unknown notification action: ${action}`);
      }
    }
  }

  /**
   * Send notification request to ServiceWorker when all tabs are hidden
   */
  private sendNotificationToServiceWorker(callInfo: SipWorker.CallInfo): void {
    if (!this.notificationChannel) {
      this.log('warn', 'BroadcastChannel not available, cannot send notification to ServiceWorker');
      return;
    }

    const notificationData = {
      type: 'SHOW_CALL_NOTIFICATION',
      callId: callInfo.id,
      callerInfo: {
        uri: callInfo.remoteUri,
        displayName: callInfo.remoteDisplayName || callInfo.remoteUri
      },
      timestamp: Date.now()
    };

    this.notificationChannel.postMessage(notificationData);
    this.log('info', `Sent notification request to ServiceWorker for call: ${callInfo.id}`);
  }

  /**
   * Send AudioContext notification request to ServiceWorker when no tab has running AudioContext
   */
  private sendAudioContextNotificationToServiceWorker(): void {
    if (!this.notificationChannel) {
      this.log('warn', 'BroadcastChannel not available, cannot send AudioContext notification to ServiceWorker');
      return;
    }

    // Throttle notifications to prevent spam
    const now = Date.now();
    if (now - this.lastAudioContextNotification < this.audioContextNotificationCooldown) {
      this.log('info', `AudioContext notification throttled (last sent ${Math.round((now - this.lastAudioContextNotification) / 1000)}s ago)`);
      return;
    }

    const notificationData = {
      type: 'SHOW_AUDIOCONTEXT_NOTIFICATION',
      timestamp: now,
      url: this.getAppUrl()
    };

    this.notificationChannel.postMessage(notificationData);
    this.lastAudioContextNotification = now;
    this.log('info', 'Sent AudioContext notification request to ServiceWorker');
  }

  /**
   * Schedule delayed AudioContext notification to avoid notifications for brief suspensions
   * @param checkType Type of check that triggered this
   */
  private scheduleDelayedAudioContextNotification(checkType: string): void {
    // Clear any existing timer
    if (this.audioContextNotificationTimer) {
      clearTimeout(this.audioContextNotificationTimer);
    }

    this.log('info', `No tab has running AudioContext (${checkType}) - scheduling notification in ${this.audioContextNotificationDelay}ms`);

    // Schedule notification after delay
    this.audioContextNotificationTimer = setTimeout(() => {
      // Double-check AudioContext state before sending notification
      const stillNoAudioContext = !this.hasTabWithRunningAudioContext();
      
      if (stillNoAudioContext) {
        this.log('info', `AudioContext still suspended after ${this.audioContextNotificationDelay}ms delay - sending notification`);
        this.sendAudioContextNotificationToServiceWorker();
      } else {
        this.log('info', `AudioContext resumed during delay period - notification cancelled`);
      }
      
      this.audioContextNotificationTimer = null;
    }, this.audioContextNotificationDelay);
  }

  /**
   * Get the application URL for notifications
   */
  private getAppUrl(): string {
    // Try to get URL from any connected tab
    const allTabs = this.tabManager.getAllTabs();
    if (allTabs.length > 0 && allTabs[0].url) {
      return allTabs[0].url;
    }
    
    // Fallback to current origin
    return self.location.origin;
  }

  /**
   * Check if any tab has running AudioContext
   */
  private hasTabWithRunningAudioContext(): boolean {
    const allTabs = this.tabManager.getAllTabs();
    return allTabs.some(tab => tab.audioContextRunning === true);
  }

  /**
   * Handle AudioContext state change (proactive notification)
   * @param hasRunningAudioContext Current state - any tab has running AudioContext
   * @param previousState Previous state
   */
  public handleAudioContextStateChange(hasRunningAudioContext: boolean, previousState: boolean): void {
    // Clear any pending notification timer when AudioContext becomes available
    if (hasRunningAudioContext && this.audioContextNotificationTimer) {
      clearTimeout(this.audioContextNotificationTimer);
      this.audioContextNotificationTimer = null;
      this.log('info', 'AudioContext became available - cancelled pending notification');
      return;
    }

    // Send notification whenever no tab has running AudioContext
    // Purpose: Always maintain at least 1 tab with running AudioContext
    if (!hasRunningAudioContext) {
      const allTabs = this.tabManager.getAllTabs();

      if (allTabs.length > 0) {
        // Check if this is a state change or periodic check
        const isStateChange = hasRunningAudioContext !== previousState;
        const checkType = isStateChange ? 'state change' : 'periodic check';
        
        // For state changes, use delay to avoid notifications for brief suspensions
        // For periodic checks, send immediately (user has been without audio for a while)
        if (isStateChange) {
          this.scheduleDelayedAudioContextNotification(checkType);
        } else {
          this.log('info', `No tab has running AudioContext (${checkType}) - sending immediate AudioContext notification`);
          this.sendAudioContextNotificationToServiceWorker();
        }
      } else {
        this.log('info', 'No tabs connected - skipping AudioContext notification');
      }
    } else {
      this.log('info', 'AudioContext is running in at least one tab - audio readiness maintained');
    }
  }

  /**
   * Xử lý cuộc gọi đến
   * @param invitation Invitation từ SIP.js
   */
  private async handleIncomingCall(invitation: Invitation): Promise<void> {
    const callId = invitation.request.callId;

    this.log('info', `Incoming call received: ${callId} from ${invitation.remoteIdentity.uri}`);

    // Extract X-Headers
    const xHeaders = Object.entries(invitation.request.headers)
      .filter(([name]) => name.startsWith('X-'))
      .reduce((acc, [name, values]) => {
        acc[name] = values[0]?.raw || '';
        return acc;
      }, {} as Record<string, string>);

    // Determine if this is a predict call
    const isPredictCall = this.isPredictCall(xHeaders);

    const callInfo: SipWorker.CallInfo = {
      id: callId,
      direction: SipWorker.CallDirection.INCOMING,
      state: SipWorker.CallState.RINGING,
      remoteUri: invitation.remoteIdentity.uri.toString(),
      remoteDisplayName: invitation.remoteIdentity.displayName || undefined,
      startTime: Date.now(),
      isMuted: false,
      isOnHold: false,
      xHeaders,
      isPredictCall,
    };

    this.log('info', `Call type: ${isPredictCall ? 'PREDICT' : 'INBOUND'}`);

    this.activeCalls.set(callId, invitation);
    this.setupInvitationListeners(invitation, callInfo);

    if (this.workerState) {
      this.workerState.setActiveCall(callId, callInfo);
    }

    // Check if we should auto-accept this call
    const shouldAutoAccept = isPredictCall ? this.autoAcceptPredictCalls : this.autoAcceptInboundCalls;
    const selectedTabId = await this.tabManager.selectBestTab();
    
    if (shouldAutoAccept) {
      this.log('info', `Auto-accepting ${isPredictCall ? 'predict' : 'inbound'} call: ${callId}`);
      
      // Update call info with selected tab (needed for media handling)
      callInfo.handlingTabId = selectedTabId || undefined;
      if (this.workerState) {
        this.workerState.setActiveCall(callId, callInfo);
      }
      
      // Auto-accept immediately without broadcasting CALL_INCOMING (no ringing)
      try {
        await this.acceptCall(callId);
      } catch (error: any) {
        this.log('error', `Failed to auto-accept call ${callId}: ${error.message}`);
      }
      return; // Skip the rest of the incoming call handling
    }

    // For non-auto-accept calls, broadcast the incoming call event
    await this.messageBroker.broadcast({
      type: SipWorker.MessageType.CALL_INCOMING,
      id: `incoming-call-${Date.now()}`,
      timestamp: Date.now(),
      data: {
        ...callInfo,
        selectedTabId,
      },
    });

    const allTabs = this.tabManager.getAllTabs();
    const visibleTabs = allTabs.filter(tab =>
      tab.state === SipWorker.TabState.ACTIVE || tab.state === SipWorker.TabState.VISIBLE
    );

    if (visibleTabs.length === 0) {
      // All tabs are hidden - show incoming call notification
      this.log('info', `All tabs are hidden, sending call notification to ServiceWorker for call: ${callId}`);
      this.sendNotificationToServiceWorker(callInfo);
    }
    // AudioContext notifications are now handled independently via handleAudioContextStateChange()
    // No need to check AudioContext state during incoming calls
  }

  /**
   * Check if incoming call is a predict call based on X-Extra header
   * @param xHeaders X-Headers from the invitation
   * @returns true if this is a predict call
   */
  private isPredictCall(xHeaders: Record<string, string>): boolean {
    // Get X-Extra header (case-insensitive)
    const extraRaw = xHeaders['X-Extra'] ?? xHeaders['x-extra'];

    if (!extraRaw) {
      return false;
    }

    // Parse X-Extra header to find the variable
    // Format: "variable1=value1;variable2=value2;..."
    const extraValue = this.getValueFromExtraVariables(extraRaw, this.predictCallExtraVariable);

    // If the variable exists and has a value, it's a predict call
    return !!extraValue;
  }

  /**
   * Extract value from X-Extra header variables
   * @param extra X-Extra header value
   * @param variableName Variable name to extract
   * @returns Variable value or null
   */
  private getValueFromExtraVariables(extra: string, variableName: string): string | null {
    if (!extra || !variableName) {
      return null;
    }

    try {
      // Split by semicolon to get individual variables
      const variables = extra.split(';');

      for (const variable of variables) {
        const [key, value] = variable.split('=').map((s) => s.trim());

        if (key && key.toLowerCase() === variableName.toLowerCase()) {
          return value || null;
        }
      }

      return null;
    } catch (error) {
      this.log('warn', `Failed to parse X-Extra header: ${error}`);
      return null;
    }
  }

  /**
   * Tạo cuộc gọi đi
   * @param request Thông tin cuộc gọi
   * @returns Promise với kết quả cuộc gọi
   */
  public async makeCall(request: SipWorker.MakeCallRequest): Promise<SipWorker.MakeCallResponse> {
    // Sử dụng callId từ client hoặc tạo mới nếu không có
    const callId = request.callId || uuidv7();

    try {
      if (!this.userAgent) {
        return {
          success: false,
          callId,
          error: 'UserAgent not initialized'
        };
      }

      // Kiểm tra đã đăng ký SIP
      if (!this.registered) {
        return {
          success: false,
          callId,
          error: 'SIP not registered'
        };
      }

      // Kiểm tra target URI
      if (!request.targetUri) {
        return {
          success: false,
          callId,
          error: 'Target URI is required'
        };
      }

      // Tạo URI đích
      const targetUri = UserAgent.makeURI(request.targetUri);
      if (!targetUri) {
        return {
          success: false,
          callId,
          error: `Invalid target URI: ${request.targetUri}`
        };
      }

      this.log('info', `Making call to: ${request.targetUri}`);

      // Thêm custom headers nếu có
      const extraHeaders: string[] = [];
      if (request.extraHeaders) {
        Object.entries(request.extraHeaders).forEach(([key, value]) => {
          extraHeaders.push(`${key}: ${value}`);
        });
      }

      const inviterOptions = {
        sessionDescriptionHandlerOptions: {
          callId,
          action: 'offer',
          constraints: { audio: true, video: false }
        } as WorkerSessionDescriptionHandlerOptions,
        extraHeaders: extraHeaders,
        params: { callId },
        earlyMedia: true, // Enable early media support
      } as InviterOptions;

      // Tạo Inviter với custom Call-ID thông qua params
      // Sử dụng trick: tạo một inviter tạm để lấy outgoingRequestMessage, sau đó hack callId
      const inviter = new Inviter(this.userAgent, targetUri, inviterOptions);

      // HACK: Override Call-ID trực tiếp trong outgoingRequestMessage
      // @ts-ignore - Truy cập thuộc tính private
      if (inviter.outgoingRequestMessage) {
        // @ts-ignore - Override Call-ID
        inviter.outgoingRequestMessage.callId = callId;
        // @ts-ignore - Update session ID
        inviter._id = callId + inviter.fromTag;
      }

      // Tạo thông tin cuộc gọi
      const callInfo: SipWorker.CallInfo = {
        id: callId,
        direction: SipWorker.CallDirection.OUTGOING,
        state: SipWorker.CallState.CONNECTING,
        remoteUri: request.targetUri,
        remoteDisplayName: targetUri.toString() || undefined,
        startTime: Date.now(),
        isMuted: false,
        isOnHold: false,
        xHeaders: {
          ...request.extraHeaders
        }
      };

      // Lưu cuộc gọi vào danh sách
      this.activeCalls.set(callId, inviter);

      // Update WorkerState với outgoing call
      if (this.workerState) {
        this.workerState.setActiveCall(callId, callInfo);
      }

      // Thiết lập event listeners cho inviter
      this.setupInviterListeners(inviter, callInfo);

      // Gửi INVITE với custom headers và request delegate để bắt reject response
      try {
        const inviteResult = await inviter.invite({
          requestOptions: {
            extraHeaders: extraHeaders
          },
          requestDelegate: {
            onReject: (response) => {
              // Trích xuất SIP status code từ reject response
              const statusCode = response.message.statusCode;
              const reasonPhrase = response.message.reasonPhrase;

              this.log('info', `Call ${callId} rejected: ${statusCode} ${reasonPhrase}`);

              // Cập nhật call info
              callInfo.statusCode = statusCode;
              callInfo.reasonPhrase = reasonPhrase;
              callInfo.reason = `${statusCode} ${reasonPhrase}`;
              callInfo.state = SipWorker.CallState.TERMINATED;
              callInfo.endTime = Date.now();

              // Cleanup
              this.cleanupCall(callId);

              // Broadcast call rejected với SIP status code
              this.messageBroker.broadcast({
                type: SipWorker.MessageType.CALL_TERMINATED,
                id: `call-rejected-${Date.now()}`,
                timestamp: Date.now(),
                data: {
                  id: callId,
                  state: SipWorker.CallState.TERMINATED,
                  endTime: Date.now(),
                  statusCode: statusCode,
                  reasonPhrase: reasonPhrase,
                  reason: `${statusCode} ${reasonPhrase}`
                }
              });
            },
            onProgress: (response) => {
              // Handle provisional responses (18x) for early media
              const statusCode = response.message.statusCode;
              const reasonPhrase = response.message.reasonPhrase;

              this.log('info', `Call ${callId} progress: ${statusCode} ${reasonPhrase}`);

              // Update call state based on provisional response
              if (statusCode === 180) {
                callInfo.state = SipWorker.CallState.RINGING;
                this.broadcastCallStatus(callInfo);
              } else if (statusCode === 183) {
                // Session Progress - early media available
                callInfo.state = SipWorker.CallState.RINGING;
                this.broadcastCallStatus(callInfo);

                // Check if response has SDP for early media
                const body = response.message.body;
                if (body && body.includes('application/sdp')) {
                  this.log('info', `Early media SDP received for call ${callId}, SDP length: ${body.length}`);
                  this.log('debug', `Early media SDP: ${body.substring(0, 200)}...`);
                  // SIP.js will automatically handle early media setup when earlyMedia: true
                } else {
                  this.log('info', `Early media indication (no SDP) for call ${callId}`);
                }
              }
            }
          }
        });

        // Broadcast thông tin cuộc gọi đi
        this.broadcastCallStatus(callInfo);

        this.log('info', `Call initiated successfully with ID: ${callId}`);

        return {
          success: true,
          callId,
          callInfo: callInfo
        };

      } catch (inviteError: any) {
        // Handle invite setup errors (không phải reject responses)
        this.log('error', `Call ${callId} setup failed: ${inviteError.message}`);

        // Cleanup
        this.cleanupCall(callId);

        // Broadcast call failed
        this.messageBroker.broadcast({
          type: SipWorker.MessageType.CALL_TERMINATED,
          id: `call-failed-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            id: callId,
            state: SipWorker.CallState.TERMINATED,
            endTime: Date.now(),
            reason: `Call setup failed: ${inviteError.message}`
          }
        });

        return {
          success: false,
          callId,
          error: inviteError.message || 'Call setup failed'
        };
      }

    } catch (error: any) {
      this.log('error', `Failed to make call: ${error.message}`);

      // Cleanup nếu có lỗi
      this.cleanupCall(callId);

      // Broadcast call failed để reset UI
      this.messageBroker.broadcast({
        type: SipWorker.MessageType.CALL_TERMINATED,
        id: `call-failed-${Date.now()}`,
        timestamp: Date.now(),
        data: {
          id: callId,
          state: SipWorker.CallState.TERMINATED,
          endTime: Date.now(),
          reason: error.message || 'Unknown error occurred'
        }
      });

      return {
        success: false,
        callId,
        error: error.message || 'Unknown error occurred'
      };
    }
  }

  /**
   * Chấp nhận cuộc gọi đến
   * @param callId ID của cuộc gọi cần chấp nhận
   * @returns Promise với kết quả
   */
  public async acceptCall(callId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const session = this.activeCalls.get(callId);
      if (!session) {
        return {
          success: false,
          error: `Call not found: ${callId}`
        };
      }

      // Kiểm tra xem đây có phải là Invitation không
      if (!(session instanceof Invitation)) {
        return {
          success: false,
          error: `Call ${callId} is not an incoming call`
        };
      }

      this.log('info', `Accepting incoming call: ${callId}`);

      await session.accept({
        sessionDescriptionHandlerOptions: {
          constraints: {
            audio: true,
            video: false
          },
          callId,
        } as WorkerSessionDescriptionHandlerOptions,
      });

      this.log('info', `Call ${callId} accepted successfully`);
      return { success: true };

    } catch (error: any) {
      this.log('error', `Failed to accept call ${callId}: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Unknown error occurred'
      };
    }
  }

  /**
   * Từ chối cuộc gọi đến
   * @param callId ID của cuộc gọi cần từ chối
   * @param statusCode SIP status code (mặc định 486 Busy Here)
   * @param reasonPhrase Reason phrase (mặc định "Busy Here")
   * @returns Promise với kết quả
   */
  public async rejectCall(callId: string, statusCode: number = 486, reasonPhrase: string = 'Busy Here'): Promise<{ success: boolean; error?: string }> {
    try {
      const session = this.activeCalls.get(callId);
      if (!session) {
        return {
          success: false,
          error: `Call not found: ${callId}`
        };
      }

      // Kiểm tra xem đây có phải là Invitation không
      if (!(session instanceof Invitation)) {
        return {
          success: false,
          error: `Call ${callId} is not an incoming call`
        };
      }

      this.log('info', `Rejecting incoming call: ${callId} with ${statusCode} ${reasonPhrase}`);

      // Từ chối cuộc gọi
      await session.reject({
        statusCode,
        reasonPhrase
      });

      // Cleanup
      this.cleanupCall(callId);

      this.log('info', `Call ${callId} rejected successfully`);
      return { success: true };

    } catch (error: any) {
      this.log('error', `Failed to reject call ${callId}: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Unknown error occurred'
      };
    }
  }

  /**
   * Kết thúc cuộc gọi
   * @param callId ID của cuộc gọi cần kết thúc
   * @returns Promise với kết quả
   */
  public async hangupCall(callId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const session = this.activeCalls.get(callId);
      if (!session) {
        return {
          success: false,
          error: `Call not found: ${callId}`
        };
      }

      this.log('info', `Hanging up call: ${callId}`);

      if (session.state === SessionState.Established) {
        await session.bye();
      } else if (session.state === SessionState.Establishing) {
        if (session instanceof Inviter) {
          await session.cancel();
        } else {
          // For incoming calls (Invitation), use reject
          const invitation = session as any;
          if (invitation.reject) {
            await invitation.reject();
          }
        }
      }

      this.cleanupCall(callId);

      await this.messageBroker.broadcast({
        type: SipWorker.MessageType.CALL_TERMINATED,
        id: `call-terminated-${Date.now()}`,
        timestamp: Date.now(),
        data: {
          id: callId,
          state: SipWorker.CallState.TERMINATED,
          endTime: Date.now()
        }
      });

      this.log('info', `Call ${callId} terminated successfully`);
      return { success: true };

    } catch (error: any) {
      this.log('error', `Failed to hangup call ${callId}: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Unknown error occurred'
      };
    }
  }

  /**
   * Thiết lập event listeners cho Invitation (cuộc gọi đến)
   * @param invitation Invitation instance
   * @param callInfo Thông tin cuộc gọi
   */
  private setupInvitationListeners(invitation: Invitation, callInfo: SipWorker.CallInfo): void {
    // Set initial call info in WorkerState right away
    if (this.workerState) {
      this.workerState.setActiveCall(callInfo.id, callInfo);
      console.log('SipCore.setupInvitationListeners: Initial call info set in WorkerState:', callInfo.id);
    }

    // Khi trạng thái invitation thay đổi
    invitation.stateChange.addListener((state) => {
      this.log('info', `Incoming call ${callInfo.id} state changed to: ${state}`);

      const currentCallInfo = this.workerState?.getActiveCall(callInfo.id) || callInfo;

      switch (state) {
        case SessionState.Establishing:
          currentCallInfo.state = SipWorker.CallState.CONNECTING;
          this.broadcastCallStatus(currentCallInfo);
          break;
        case SessionState.Established:
          currentCallInfo.state = SipWorker.CallState.ESTABLISHED;
          currentCallInfo.establishedTime = Date.now();
          this.broadcastCallStatus(currentCallInfo);
          break;
        case SessionState.Terminated:
          currentCallInfo.state = SipWorker.CallState.TERMINATED;
          currentCallInfo.endTime = Date.now();
          this.cleanupCall(callInfo.id);
          this.broadcastCallStatus(currentCallInfo);

          // Broadcast CALL_TERMINATED để reset UI
          this.messageBroker.broadcast({
            type: SipWorker.MessageType.CALL_TERMINATED,
            id: `call-terminated-${Date.now()}`,
            timestamp: Date.now(),
            data: {
              id: currentCallInfo.id,
              state: SipWorker.CallState.TERMINATED,
              endTime: Date.now(),
              handlingTabId: currentCallInfo.handlingTabId // Include handlingTabId for cleanup
            }
          });
          break;
      }
    });
  }

  /**
   * Thiết lập các sự kiện cho Inviter (cuộc gọi đi)
   * @param inviter Inviter session
   * @param callInfo Thông tin cuộc gọi
   */
  private setupInviterListeners(inviter: Inviter, callInfo: SipWorker.CallInfo): void {
    // Set initial call info in WorkerState right away
    if (this.workerState) {
      this.workerState.setActiveCall(callInfo.id, callInfo);
      console.log('SipCore.setupInviterListeners: Initial call info set in WorkerState:', callInfo.id);
    }

    // Khi nhận được provisional response
    inviter.stateChange.addListener((state) => {
      this.log('info', `Call ${callInfo.id} state changed to: ${state}`);

      // Get current call info from WorkerState to preserve handlingTabId
      const currentCallInfo = this.workerState?.getActiveCall(callInfo.id) || callInfo;

      switch (state) {
        case SessionState.Establishing:
          currentCallInfo.state = SipWorker.CallState.RINGING;
          this.broadcastCallStatus(currentCallInfo);
          break;
        case SessionState.Established:
          currentCallInfo.state = SipWorker.CallState.ESTABLISHED;
          currentCallInfo.establishedTime = Date.now();
          this.broadcastCallStatus(currentCallInfo);
          break;
        case SessionState.Terminated:
          currentCallInfo.state = SipWorker.CallState.TERMINATED;
          currentCallInfo.endTime = Date.now();

          // Trích xuất SIP status code nếu có
          if (inviter.delegate && (inviter.delegate as any).terminateReason) {
            const terminateReason = (inviter.delegate as any).terminateReason;
            if (terminateReason.statusCode) {
              currentCallInfo.statusCode = terminateReason.statusCode;
              currentCallInfo.reasonPhrase = terminateReason.reasonPhrase;
              currentCallInfo.reason = `${terminateReason.statusCode} ${terminateReason.reasonPhrase}`;
            }
          }

          this.cleanupCall(callInfo.id);
          this.broadcastCallStatus(currentCallInfo);

          // Broadcast CALL_TERMINATED để reset UI với SIP status code
          this.messageBroker.broadcast({
            type: SipWorker.MessageType.CALL_TERMINATED,
            id: `call-terminated-${Date.now()}`,
            timestamp: Date.now(),
            data: {
              id: currentCallInfo.id,
              state: SipWorker.CallState.TERMINATED,
              endTime: Date.now(),
              statusCode: currentCallInfo.statusCode,
              reasonPhrase: currentCallInfo.reasonPhrase,
              reason: currentCallInfo.reason,
              handlingTabId: currentCallInfo.handlingTabId // Include handlingTabId for cleanup
            }
          });
          break;
      }
    });

    // Note: Reject/Cancel events được xử lý thông qua invite() promise rejection
    // và stateChange events đã handle việc cleanup
  }

  /**
   * Broadcast trạng thái cuộc gọi đến tất cả tabs
   * @param callInfo Thông tin cuộc gọi
   */
  private broadcastCallStatus(callInfo: SipWorker.CallInfo): void {
    // Update WorkerState with preserved handlingTabId and other important properties
    if (this.workerState) {
      if (callInfo.state === SipWorker.CallState.TERMINATED) {
        this.workerState.removeActiveCall(callInfo.id);
      } else {
        // Get existing call info to preserve handlingTabId and other properties
        const existingCallInfo = this.workerState.getActiveCall(callInfo.id);
        const updatedCallInfo: SipWorker.CallInfo = {
          ...callInfo,
          // Preserve these critical properties from existing call info
          handlingTabId: callInfo.handlingTabId || existingCallInfo?.handlingTabId,
          isMuted: callInfo.isMuted ?? existingCallInfo?.isMuted ?? false,
          isOnHold: callInfo.isOnHold ?? existingCallInfo?.isOnHold ?? false,
          originalSdp: callInfo.originalSdp || existingCallInfo?.originalSdp,
          startTime: callInfo.startTime || existingCallInfo?.startTime || Date.now()
        };

        this.workerState.setActiveCall(callInfo.id, updatedCallInfo);
        console.log('SipCore.broadcastCallStatus: Updated call info with preserved properties:', updatedCallInfo.id, 'handlingTabId:', updatedCallInfo.handlingTabId);
      }
    }

    this.messageBroker.broadcast({
      type: SipWorker.MessageType.CALL_PROGRESS,
      id: `call-progress-${Date.now()}`,
      timestamp: Date.now(),
      data: callInfo
    });
  }

  /**
   * Sync current call state to a specific tab (for new tabs)
   * @param tabId ID của tab cần sync
   */
  public syncCallStateToTab(tabId: string): void {
    // Send current registration state
    if (this.registered) {
      this.messageBroker.sendToTab(tabId, {
        type: SipWorker.MessageType.SIP_REGISTERED,
        id: `sync-registration-${Date.now()}`,
        timestamp: Date.now(),
        data: {
          uri: this.sipConfig.uri,
          username: this.sipConfig.username,
          displayName: this.sipConfig.displayName
        }
      });
    }

    // Send current active calls
    this.activeCalls.forEach((session, callId) => {
      const callInfo = this.getCallInfoFromSession(session, callId);
      if (callInfo) {
        // Send call progress for ongoing calls
        this.messageBroker.sendToTab(tabId, {
          type: SipWorker.MessageType.CALL_PROGRESS,
          id: `sync-call-${Date.now()}`,
          timestamp: Date.now(),
          data: callInfo
        });

        // Send specific call state messages based on current state
        if (callInfo.state === SipWorker.CallState.RINGING && callInfo.direction === SipWorker.CallDirection.INCOMING) {
          // Send incoming call notification for ringing incoming calls
          this.messageBroker.sendToTab(tabId, {
            type: SipWorker.MessageType.CALL_INCOMING,
            id: `sync-incoming-${Date.now()}`,
            timestamp: Date.now(),
            data: callInfo
          });
        }
      }
    });
  }

  /**
   * Extract call info from session for sync purposes
   * @param session SIP session
   * @param callId Call ID
   * @returns Call info or null
   */
  private getCallInfoFromSession(session: Session, callId: string): SipWorker.CallInfo | null {
    try {
      const isOutgoing = session instanceof Inviter;
      const remoteUri = isOutgoing ?
        (session as Inviter).remoteIdentity.uri.toString() :
        (session as Invitation).remoteIdentity.uri.toString();

      const remoteDisplayName = isOutgoing ?
        (session as Inviter).remoteIdentity.displayName :
        (session as Invitation).remoteIdentity.displayName;

      // Map session state to call state
      let callState: SipWorker.CallState;
      switch (session.state) {
        case SessionState.Initial:
          callState = SipWorker.CallState.CONNECTING;
          break;
        case SessionState.Establishing:
          callState = isOutgoing ? SipWorker.CallState.RINGING : SipWorker.CallState.RINGING;
          break;
        case SessionState.Established:
          callState = SipWorker.CallState.ESTABLISHED;
          break;
        case SessionState.Terminated:
          callState = SipWorker.CallState.TERMINATED;
          break;
        default:
          callState = SipWorker.CallState.CONNECTING;
      }

      // Get existing call info from WorkerState to preserve mute/hold states
      const existingCallInfo = this.workerState?.getActiveCall(callId);

      return {
        id: callId,
        direction: isOutgoing ? SipWorker.CallDirection.OUTGOING : SipWorker.CallDirection.INCOMING,
        state: callState,
        remoteUri,
        remoteDisplayName,
        startTime: existingCallInfo?.startTime || Date.now(), // Use existing start time if available
        isMuted: existingCallInfo?.isMuted || false,
        isOnHold: existingCallInfo?.isOnHold || false,
        handlingTabId: existingCallInfo?.handlingTabId // Preserve handlingTabId
      };
    } catch (error) {
      console.error('Failed to extract call info from session:', error);
      return null;
    }
  }

  /**
   * Đăng ký SIP
   * @param credentials Thông tin đăng nhập mới (nếu có)
   * @returns Kết quả đăng ký
   */
  public async register(credentials?: SipCredentials): Promise<any> {
    // Nếu có thông tin đăng nhập mới, cập nhật trước
    if (credentials) {
      this.updateCredentials(credentials);
    }

    // Validate required fields
    if (!this.sipConfig.uri) {
      const error = 'Cannot register: SIP URI is required';
      this.log('error', error);
      this.broadcastRegistrationFailed(error);
      return { success: false, error };
    }

    if (!this.sipConfig.username) {
      const error = 'Cannot register: Username is required';
      this.log('error', error);
      this.broadcastRegistrationFailed(error);
      return { success: false, error };
    }

    if (!this.sipConfig.password) {
      const error = 'Cannot register: Password is required';
      this.log('error', error);
      this.broadcastRegistrationFailed(error);
      return { success: false, error };
    }

    if (!this.transportConfig.server) {
      const error = 'Cannot register: WebSocket server is required';
      this.log('error', error);
      this.broadcastRegistrationFailed(error);
      return { success: false, error };
    }

    // Validate WebSocket server URL format
    if (!this.transportConfig.server.startsWith('ws://') && !this.transportConfig.server.startsWith('wss://')) {
      const error = `Invalid WebSocket server URL: ${this.transportConfig.server}. Must start with ws:// or wss://`;
      this.log('error', error);
      this.broadcastRegistrationFailed(error);
      return { success: false, error };
    }

    if (!this.userAgent) {
      this.log('info', 'UserAgent not initialized, initializing now...');
      this.initUserAgent();

      // Đợi UserAgent được khởi tạo
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (!this.userAgent) {
        const error = 'Failed to initialize UserAgent';
        this.log('error', error);
        this.broadcastRegistrationFailed(error);
        return { success: false, error };
      }
    }

    this.log('info', `Attempting to register SIP account: ${this.sipConfig.username}@${this.sipConfig.uri.replace('sip:', '')}`);

    // Start UserAgent nếu chưa start
    try {
      this.log('info', 'Starting UserAgent...');
      await this.userAgent.start();
      this.log('info', 'UserAgent started successfully');
    } catch (error: any) {
      this.log('error', `Failed to start UserAgent: ${error.message}`);
      this.log('error', `UserAgent start error stack: ${error.stack}`);
      this.broadcastRegistrationFailed(`Failed to start UserAgent: ${error.message}`);
      return { success: false, error: error.message };
    }

    try {
      // Hủy registerer cũ nếu có
      if (this.registerer) {
        this.registerer.dispose();
        this.registerer = null;
      }

      // Determine refresh strategy with validation
      const standardRefreshFrequency = this.sipConfig.sipOptions?.['refreshFrequency'] || 85;
      const customRefreshFrequency = this.sipConfig.customRefreshFrequency;

      // Validate custom refresh frequency
      if (customRefreshFrequency !== undefined) {
        if (customRefreshFrequency <= 0 || customRefreshFrequency >= 100) {
          this.log('warn', `Invalid customRefreshFrequency: ${customRefreshFrequency}%. Must be 1-99. Using standard refresh.`);
          this.useCustomRefresh = false;
        } else if (customRefreshFrequency < 10) {
          this.log('warn', `Very aggressive customRefreshFrequency: ${customRefreshFrequency}%. This may cause server rate limiting.`);
          this.useCustomRefresh = customRefreshFrequency < 50 || customRefreshFrequency < standardRefreshFrequency;
        } else {
          // Use custom refresh only if it's more aggressive (smaller) than standard limits
          this.useCustomRefresh = customRefreshFrequency < 50 || customRefreshFrequency < standardRefreshFrequency;
        }
      } else {
        this.useCustomRefresh = false;
      }

      if (this.useCustomRefresh) {
        this.log('info', `Using custom refresh frequency: ${customRefreshFrequency}% (bypassing SIP.js ${standardRefreshFrequency}% limit)`);
      } else if (customRefreshFrequency !== undefined) {
        this.log('info', `Custom refresh frequency ${customRefreshFrequency}% not more aggressive than standard ${standardRefreshFrequency}%, using SIP.js auto-refresh`);
      }

      // Tạo Registerer mới
      this.registerer = new Registerer(this.userAgent, {
        expires: this.sipConfig.registerExpires || 600,
        // If using custom refresh, set SIP.js refresh to 99 (maximum) to effectively disable it
        // Otherwise use the standard refresh frequency (must be 50-99 for SIP.js)
        refreshFrequency: this.useCustomRefresh ? 99 : Math.max(50, standardRefreshFrequency),
      });

      // Note: We'll extract expires from the registerer after successful registration
      // SIP.js Registerer doesn't expose delegate pattern, so we'll use a different approach

      // Thiết lập các sự kiện
      this.setupRegistererListeners();

      // Đăng ký
      await this.registerer.register();
      return { success: true };
    } catch (error: any) {
      this.log('error', `Registration failed: ${error.message}`);
      this.broadcastRegistrationFailed(error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Hủy đăng ký SIP
   * @returns Kết quả hủy đăng ký
   */
  public async unregister(): Promise<any> {
    // Stop any ongoing reconnection attempts
    this.stopReconnection();

    // Stop custom refresh timer
    this.stopCustomRefreshTimer();
    
    // Stop AudioContext notification timer
    this.stopAudioContextNotificationTimer();

    if (!this.registerer) {
      const error = 'Cannot unregister: Not registered';
      this.log('error', error);
      return { success: false, error };
    }

    try {
      await this.registerer.unregister();
      return { success: true };
    } catch (error: any) {
      this.log('error', `Unregistration failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Broadcast trạng thái đăng ký SIP đến tất cả các tab
   * @param registered Đã đăng ký thành công hay không
   */
  private broadcastRegistrationState(registered: boolean): void {
    // Update WorkerState
    if (this.workerState) {
      this.workerState.setSipRegistration({
        registered,
        uri: this.sipConfig.uri,
        username: this.sipConfig.username,
        displayName: this.sipConfig.displayName
      });
    }

    this.messageBroker.broadcast({
      type: registered ? SipWorker.MessageType.SIP_REGISTERED : SipWorker.MessageType.SIP_UNREGISTERED,
      id: `sip-registration-${Date.now()}`,
      timestamp: Date.now(),
      data: {
        uri: this.sipConfig.uri,
        username: this.sipConfig.username,
        displayName: this.sipConfig.displayName
      }
    });
  }

  /**
   * Broadcast thông báo đăng ký SIP thất bại đến tất cả các tab
   * @param error Lỗi đăng ký
   */
  private broadcastRegistrationFailed(error: string): void {
    this.messageBroker.broadcast({
      type: SipWorker.MessageType.SIP_REGISTRATION_FAILED,
      id: `sip-registration-failed-${Date.now()}`,
      timestamp: Date.now(),
      data: {
        uri: this.sipConfig.uri,
        username: this.sipConfig.username,
        displayName: this.sipConfig.displayName,
        error
      }
    });
  }

  /**
   * Ghi log
   * @param level Level của log
   * @param message Nội dung log
   */
  private log(level: string, message: string): void {
    // Ghi log ra console nếu cần
    if (this.logConfig.console) {
      switch (level) {
        case 'debug':
          console.debug(message);
          break;
        case 'info':
          console.info(message);
          break;
        case 'warn':
          console.warn(message);
          break;
        case 'error':
          console.error(message);
          break;
        default:
          console.log(message);
          break;
      }
    }

    // Gửi log về client
    this.sendLogToClient(level, message);
  }

  /**
   * Kiểm tra xem đã đăng ký SIP chưa
   * @returns true nếu đã đăng ký, false nếu chưa
   */
  public isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Gửi DTMF tones
   * @param callId ID của cuộc gọi
   * @param tones Chuỗi DTMF tones
   * @param options Tùy chọn DTMF
   * @returns Promise với kết quả
   */
  public async sendDtmf(callId: string, tones: string, options?: any): Promise<{ success: boolean; error?: string }> {
    try {
      const session = this.activeCalls.get(callId);
      if (!session) {
        return { success: false, error: 'Call not found' };
      }

      if (session.state !== SessionState.Established) {
        return { success: false, error: 'Call is not established' };
      }

      this.log('info', `Sending DTMF tones: ${tones} for call: ${callId}`);

      // Hybrid approach: Try WebRTC first, fallback to SIP INFO
      const webrtcTimeout = options?.webrtcTimeout || 2000; // 2 seconds timeout

      try {
        // Method 1: Try WebRTC DTMF (preferred for better compatibility and real-time)
        const result = await this.sendDtmfViaWebRTC(callId, tones, options, webrtcTimeout);
        if (result.success) {
          this.log('info', `DTMF sent successfully via WebRTC: ${tones}`);
          return result;
        }

        // If WebRTC failed, log and continue to fallback
        this.log('warn', `WebRTC DTMF failed: ${result.error}, falling back to SIP INFO`);
      } catch (error: any) {
        // If WebRTC timeout or error, log and continue to fallback
        this.log('warn', `WebRTC DTMF timeout/error: ${error.message}, falling back to SIP INFO`);
      }

      // Method 2: Fallback to SIP INFO messages (in-band)
      await session.info({
        requestOptions: {
          body: {
            contentDisposition: "render",
            contentType: "application/dtmf-relay",
            content: `Signal=${tones}\r\nDuration=${options?.duration || 100}`
          }
        }
      });

      this.log('info', `DTMF sent successfully via SIP INFO (fallback): ${tones}`);
      return { success: true };
    } catch (error: any) {
      this.log('error', `Failed to send DTMF: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Gửi DTMF qua WebRTC (RFC 4733) với timeout
   * @param callId ID của cuộc gọi
   * @param tones DTMF tones
   * @param options Tùy chọn DTMF
   * @param timeout Timeout in milliseconds
   * @returns Promise với kết quả
   */
  private async sendDtmfViaWebRTC(
    callId: string,
    tones: string,
    options?: any,
    timeout: number = 2000
  ): Promise<{ success: boolean; error?: string }> {

    // Get call info to find the handling tab
    const currentCallInfo = this.workerState?.getActiveCall(callId);
    let handlingTabId = currentCallInfo?.handlingTabId;

    // If no handlingTabId, try to find any available tab
    if (!handlingTabId) {
      const availableTabIds = this.messageBroker.getTabIds();

      if (availableTabIds.length > 0) {
        handlingTabId = availableTabIds[0]; // Use first available tab
        this.log('info', `No handlingTabId found, using first available tab: ${handlingTabId}`);
      } else {
        return { success: false, error: 'No handling tab found for WebRTC DTMF' };
      }
    }

    // Check if tab still exists
    if (!this.messageBroker.hasTab(handlingTabId)) {
      return { success: false, error: 'Handling tab no longer connected' };
    }

    // Create DTMF request for WebRTC
    const dtmfRequest: SipWorker.DtmfRequest = {
      callId: callId,
      tones: tones,
      duration: options?.duration || 100,
      interToneGap: options?.interToneGap || 100
    };

    const request: SipWorker.Message<SipWorker.DtmfRequest> = {
      type: SipWorker.MessageType.DTMF_REQUEST_WEBRTC,
      id: `dtmf-webrtc-${Date.now()}`,
      timestamp: Date.now(),
      data: dtmfRequest
    };

    try {
      this.log('info', `Sending WebRTC DTMF to tab: ${handlingTabId}`);

      // Send DTMF message to tab (not a request/response pattern)
      // Tab will handle it and send back DTMF_SENT or DTMF_FAILED message
      await this.messageBroker.sendToTab(handlingTabId, request);

      // Wait for DTMF response with timeout
      return new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (!isResolved) {
            cleanup();
            reject(new Error(`WebRTC DTMF timeout after ${timeout}ms`));
          }
        }, timeout);

        let isResolved = false;

        const cleanup = () => {
          if (!isResolved) {
            clearTimeout(timeoutId);
            dtmfSentUnsubscribe();
            dtmfFailedUnsubscribe();
            isResolved = true;
          }
        };

        const dtmfSentUnsubscribe = this.messageBroker.on(SipWorker.MessageType.DTMF_SENT, async (message) => {
          const response = message.data as SipWorker.DtmfResponse;
          // Match both callId and request ID to prevent race conditions between multiple DTMF requests
          // Client sends response with ID pattern: "dtmf-response-{originalRequestId}"
          if (response && response.callId === callId && message.id.includes(request.id) && !isResolved) {
            cleanup();
            resolve({ success: true });
          }
        });

        const dtmfFailedUnsubscribe = this.messageBroker.on(SipWorker.MessageType.DTMF_FAILED, async (message) => {
          const response = message.data as SipWorker.DtmfResponse;
          // Match both callId and request ID to prevent race conditions between multiple DTMF requests
          // Client sends response with ID pattern: "dtmf-response-{originalRequestId}"
          if (response && response.callId === callId && message.id.includes(request.id) && !isResolved) {
            cleanup();
            resolve({ success: false, error: response.error || 'WebRTC DTMF failed' });
          }
        });
      });
    } catch (error: any) {
      return { success: false, error: `WebRTC DTMF error: ${error.message}` };
    }
  }

  /**
   * Mute cuộc gọi
   * @param callId ID của cuộc gọi
   * @returns Promise với kết quả
   */
  public async muteCall(callId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const session = this.activeCalls.get(callId);
      if (!session) {
        return { success: false, error: 'Call not found' };
      }

      if (session.state !== SessionState.Established) {
        return { success: false, error: 'Call is not established' };
      }

      this.log('info', `Muting call: ${callId}`);

      // Get the tab that owns this session
      const currentCallInfo = this.workerState?.getActiveCall(callId);
      const handlingTabId = currentCallInfo?.handlingTabId;

      console.log(`SipCore.muteCall: callId=${callId}, currentCallInfo=`, currentCallInfo);
      console.log(`SipCore.muteCall: handlingTabId=${handlingTabId}`);

      if (handlingTabId) {
        // Send mute request specifically to the tab that owns the session
        this.log('info', `Sending mute request to handling tab: ${handlingTabId}`);

        await this.messageBroker.sendToTab(handlingTabId, {
          type: SipWorker.MessageType.CALL_MUTE,
          id: `call-mute-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            callId: callId,
            action: 'mute'
          }
        });
      } else {
        // Fallback: broadcast to all tabs if handlingTabId is not known
        // This should rarely happen if WorkerSessionDescriptionHandler is working correctly
        this.log('warn', `No handlingTabId found for call ${callId}, broadcasting to all tabs`);
        this.log('warn', `This may cause "Session not found" errors in tabs that don't own the session - this is normal`);

        await this.messageBroker.broadcast({
          type: SipWorker.MessageType.CALL_MUTE,
          id: `call-mute-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            callId: callId,
            action: 'mute'
          }
        });
      }

      this.log('info', `Mute request sent for call: ${callId}`);

      // Update call state in WorkerState
      if (currentCallInfo && this.workerState) {
        this.workerState.setActiveCall(callId, {
          ...currentCallInfo,
          isMuted: true
        });
      }

      return { success: true };
    } catch (error: any) {
      this.log('error', `Failed to mute call: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Unmute cuộc gọi
   * @param callId ID của cuộc gọi
   * @returns Promise với kết quả
   */
  public async unmuteCall(callId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const session = this.activeCalls.get(callId);
      if (!session) {
        return { success: false, error: 'Call not found' };
      }

      if (session.state !== SessionState.Established) {
        return { success: false, error: 'Call is not established' };
      }

      this.log('info', `Unmuting call: ${callId}`);

      // Get the tab that owns this session
      const currentCallInfo = this.workerState?.getActiveCall(callId);
      const handlingTabId = currentCallInfo?.handlingTabId;

      if (handlingTabId) {
        // Send unmute request specifically to the tab that owns the session
        this.log('info', `Sending unmute request to handling tab: ${handlingTabId}`);

        await this.messageBroker.sendToTab(handlingTabId, {
          type: SipWorker.MessageType.CALL_UNMUTE,
          id: `call-unmute-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            callId: callId,
            action: 'unmute'
          }
        });
      } else {
        // Fallback: broadcast to all tabs if handlingTabId is not known
        // This should rarely happen if WorkerSessionDescriptionHandler is working correctly
        this.log('warn', `No handlingTabId found for call ${callId}, broadcasting to all tabs`);
        this.log('warn', `This may cause "Session not found" errors in tabs that don't own the session - this is normal`);

        await this.messageBroker.broadcast({
          type: SipWorker.MessageType.CALL_UNMUTE,
          id: `call-unmute-${Date.now()}`,
          timestamp: Date.now(),
          data: {
            callId: callId,
            action: 'unmute'
          }
        });
      }

      this.log('info', `Unmute request sent for call: ${callId}`);

      // Update call state in WorkerState
      if (currentCallInfo && this.workerState) {
        this.workerState.setActiveCall(callId, {
          ...currentCallInfo,
          isMuted: false
        });
      }

      return { success: true };
    } catch (error: any) {
      this.log('error', `Failed to unmute call: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Hold cuộc gọi với SDP re-negotiation
   * @param callId ID của cuộc gọi
   * @returns Promise với kết quả
   */
  public async holdCall(callId: string): Promise<{ success: boolean; error?: string }> {
    console.log('SipCore.holdCall', callId);

    const session = this.activeCalls.get(callId);
    if (!session) {
      return { success: false, error: 'Call not found' };
    }

    const callInfo = this.workerState?.getActiveCall(callId);
    if (!callInfo) {
      return { success: false, error: 'Call info not found' };
    }

    try {
      console.log('Sending hold re-INVITE for call:', callId);

      // Send re-INVITE with hold=true option and callId
      await session.invite({
        sessionDescriptionHandlerOptions: {
          callId: callId,
          hold: true
        } as any
      });

      console.log('Hold re-INVITE succeeded for call:', callId);

      // Update isOnHold state after successful hold
      if (this.workerState) {
        this.workerState.setActiveCall(callId, {
          ...callInfo,
          isOnHold: true
        });
        console.log('Updated isOnHold=true for call:', callId);
      }

      return { success: true };
    } catch (error) {
      console.error('Hold re-INVITE failed for call:', callId, error);

      // Check if it's a timeout error
      if (error instanceof Error && error.message.includes('timeout')) {
        return { success: false, error: `Hold operation timeout: ${error.message}` };
      }

      return { success: false, error: `Hold failed: ${error}` };
    }
  }

  /**
   * Unhold cuộc gọi với SDP re-negotiation
   * @param callId ID của cuộc gọi
   * @returns Promise với kết quả
   */
  public async unholdCall(callId: string): Promise<{ success: boolean; error?: string }> {
    console.log('SipCore.unholdCall', callId);

    const session = this.activeCalls.get(callId);
    if (!session) {
      return { success: false, error: 'Call not found' };
    }

    const callInfo = this.workerState?.getActiveCall(callId);
    if (!callInfo) {
      return { success: false, error: 'Call info not found' };
    }

    try {
      console.log('Sending unhold re-INVITE for call:', callId);

      // Send re-INVITE with hold=false option and callId
      await session.invite({
        sessionDescriptionHandlerOptions: {
          callId: callId,
          hold: false
        } as any
      });

      console.log('Unhold re-INVITE succeeded for call:', callId);

      // Update isOnHold state after successful unhold
      if (this.workerState) {
        this.workerState.setActiveCall(callId, {
          ...callInfo,
          isOnHold: false
        });
        console.log('Updated isOnHold=false for call:', callId);
      }

      return { success: true };
    } catch (error) {
      console.error('Unhold re-INVITE failed for call:', callId, error);

      // Check if it's a timeout error
      if (error instanceof Error && error.message.includes('timeout')) {
        return { success: false, error: `Unhold operation timeout: ${error.message}` };
      }

      return { success: false, error: `Unhold failed: ${error}` };
    }
  }

  /**
   * Transfer cuộc gọi (blind transfer)
   * @param callId ID của cuộc gọi
   * @param targetUri URI đích
   * @param extraHeaders Các header tùy chọn
   * @returns Promise với kết quả
   */
  public async transferCall(callId: string, targetUri: string, extraHeaders?: Record<string, string>): Promise<{ success: boolean; error?: string }> {
    try {
      const session = this.activeCalls.get(callId);
      if (!session) {
        return { success: false, error: 'Call not found' };
      }

      if (session.state !== SessionState.Established) {
        return { success: false, error: 'Call is not established' };
      }

      this.log('info', `Transferring call ${callId} to ${targetUri}`);

      // SIP.js refer implementation
      if (session instanceof Invitation || session instanceof Inviter) {
        // Create refer target URI
        const referTo = UserAgent.makeURI(targetUri);
        if (!referTo) {
          return { success: false, error: 'Invalid target URI' };
        }

        // Send REFER request
        const referOptions = extraHeaders ? {
          requestOptions: {
            extraHeaders: Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`)
          }
        } : {};

        const referrer = await session.refer(referTo, referOptions);

        // TODO: Implement proper REFER state monitoring
        // For now, assume transfer is successful if REFER was sent
        this.log('info', `REFER sent for call transfer: ${callId}`);
        return { success: true };
      }

      return { success: false, error: 'Session does not support transfer' };
    } catch (error: any) {
      this.log('error', `Failed to transfer call: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Lấy UserAgent
   * @returns UserAgent của SIP.js
   */
  public getUserAgent(): UserAgent | null {
    return this.userAgent;
  }

  /**
   * Get reconnection status
   * @returns Reconnection status information
   */
  public getReconnectionStatus(): {
    isReconnecting: boolean;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
    reconnectDelay: number;
    currentDelay: number;
    maxReconnectDelay: number;
    backoffMultiplier: number;
  } {
    return {
      isReconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      reconnectDelay: this.reconnectDelay,
      currentDelay: this.currentDelay,
      maxReconnectDelay: this.maxReconnectDelay,
      backoffMultiplier: this.backoffMultiplier
    };
  }

  /**
   * Set reconnection configuration
   * @param config Reconnection configuration
   */
  public setReconnectionConfig(config: {
    maxAttempts?: number;
    delay?: number;
    maxDelay?: number;
    backoffMultiplier?: number;
  }): void {
    if (config.maxAttempts !== undefined) {
      this.maxReconnectAttempts = config.maxAttempts;
    }
    if (config.delay !== undefined) {
      this.reconnectDelay = config.delay;
      this.currentDelay = config.delay; // Reset current delay
    }
    if (config.maxDelay !== undefined) {
      this.maxReconnectDelay = config.maxDelay;
    }
    if (config.backoffMultiplier !== undefined) {
      this.backoffMultiplier = config.backoffMultiplier;
    }
    this.log('info', `Reconnection config updated: initialDelay=${this.reconnectDelay}ms, maxDelay=${this.maxReconnectDelay}ms, backoffMultiplier=${this.backoffMultiplier}`);
  }

  /**
   * Manually trigger reconnection (for testing/debugging)
   * @returns Promise with reconnection result
   */
  public async triggerReconnection(): Promise<{ success: boolean; error?: string }> {
    try {
      this.log('info', 'Manual reconnection triggered');
      this.reconnectAttempts = 0; // Reset attempts for manual trigger
      await this.attemptReconnection();
      return { success: true };
    } catch (error: any) {
      this.log('error', `Manual reconnection failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle transport disconnect and trigger reconnection
   */
  private handleTransportDisconnect(): void {
    if (this.isReconnecting) {
      this.log('info', 'Already attempting to reconnect, skipping...');
      return;
    }

    this.log('info', `Transport disconnected, attempting to reconnect (attempt ${this.reconnectAttempts + 1})`);

    // Update worker state
    if (this.workerState) {
      this.workerState.setReconnection({
        isReconnecting: true,
        reconnectAttempts: this.reconnectAttempts + 1,
        lastReconnectAttempt: Date.now()
      });
    }

    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(this.currentDelay, this.maxReconnectDelay);
    this.log('info', `Scheduling reconnection attempt in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Schedule reconnection attempt
    this.reconnectTimer = setTimeout(() => {
      this.attemptReconnection();
    }, delay) as any;
  }

  /**
   * Attempt to reconnect transport and re-register SIP
   */
  private async attemptReconnection(): Promise<void> {
    try {
      this.log('info', `Attempting reconnection (attempt ${this.reconnectAttempts})`);

      // Add safeguard: Stop after 100 attempts to prevent resource exhaustion
      if (this.reconnectAttempts > 100) {
        this.log('warn', 'Reconnection attempts exceeded 100, stopping to prevent resource exhaustion');
        this.broadcastRegistrationFailed('Too many reconnection attempts, stopping to prevent resource exhaustion');
        this.stopReconnection();
        return;
      }

      // Reset UserAgent if it exists
      if (this.userAgent) {
        try {
          await this.userAgent.stop();
          this.log('info', 'UserAgent stopped for reconnection');
        } catch (error: any) {
          this.log('warn', `Error stopping UserAgent: ${error.message}`);
        }
      }

      // Reinitialize UserAgent
      this.initUserAgent();

      if (!this.userAgent) {
        throw new Error('Failed to reinitialize UserAgent');
      }

      // Start UserAgent
      await this.userAgent.start();
      this.log('info', 'UserAgent restarted successfully');

      // Re-register SIP
      if (this.sipConfig.username && this.sipConfig.password && this.sipConfig.uri) {
        this.log('info', 'Re-registering SIP after reconnection');
        await this.register();
      }

      // Reset reconnection state on success
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.currentDelay = this.reconnectDelay; // Reset delay to initial value
      this.log('info', 'Reconnection successful');

      // Update worker state
      if (this.workerState) {
        this.workerState.setReconnection({
          isReconnecting: false,
          reconnectAttempts: 0
        });
      }

    } catch (error: any) {
      this.log('error', `Reconnection attempt failed: ${error.message}`);
      this.isReconnecting = false;

      // Apply exponential backoff for next attempt
      this.currentDelay = Math.min(this.currentDelay * this.backoffMultiplier, this.maxReconnectDelay);
      this.log('info', `Next reconnection attempt will be in ${this.currentDelay}ms`);

      // Update worker state
      if (this.workerState) {
        this.workerState.setReconnection({
          isReconnecting: false
        });
      }

      // Schedule next reconnection attempt
      this.handleTransportDisconnect();
    }
  }

  /**
   * Stop reconnection attempts
   */
  private stopReconnection(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.currentDelay = this.reconnectDelay; // Reset to initial delay
    this.log('info', 'Reconnection attempts stopped');

    // Update worker state
    if (this.workerState) {
      this.workerState.setReconnection({
        isReconnecting: false,
        reconnectAttempts: 0
      });
    }
  }

  /**
   * Extract actual expires time from server response
   * Initialize with requested expires immediately, then correct if needed
   */
  private extractActualExpires(): void {
    // Initialize immediately with requested expires to avoid 0-second calculations
    this.actualExpiresTime = this.sipConfig.registerExpires || 600;
    this.log('info', `Initial expires baseline: ${this.actualExpiresTime} seconds`);

    // Use a small delay to try to get the actual server expires
    setTimeout(() => {
      try {
        // Try to get expires from the registerer's contact
        if (this.registerer && (this.registerer as any).contact) {
          const contact = (this.registerer as any).contact;
          if (contact && contact.expires !== undefined) {
            const serverExpires = contact.expires;
            if (serverExpires !== this.actualExpiresTime) {
              this.actualExpiresTime = serverExpires;
              this.log('info', `Server returned different expires: ${this.actualExpiresTime} seconds (from registerer contact)`);

              // Restart custom timer with correct expires
              if (this.useCustomRefresh) {
                this.startCustomRefreshTimer();
              }
            }
            return;
          }
        }

        // Alternative: try to parse from registerer's internal state
        if (this.registerer) {
          // Check if registerer has any internal expires information
          const registererAny = this.registerer as any;
          if (registererAny._expires && registererAny._expires !== this.actualExpiresTime) {
            this.actualExpiresTime = registererAny._expires;
            this.log('info', `Server returned different expires: ${this.actualExpiresTime} seconds (from registerer internal)`);

            // Restart custom timer with correct expires
            if (this.useCustomRefresh) {
              this.startCustomRefreshTimer();
            }
            return;
          }
        }

        // Fallback: assume server uses common policy (120s based on your logs)
        // This is a reasonable assumption for your specific server
        const requestedExpires = this.sipConfig.registerExpires || 600;
        if (requestedExpires > 120) {
          const serverExpires = 120; // Your server's known policy
          if (serverExpires !== this.actualExpiresTime) {
            this.actualExpiresTime = serverExpires;
            this.log('info', `Using known server policy: ${this.actualExpiresTime} seconds (server typically caps at 120s)`);

            // Restart custom timer with correct expires
            if (this.useCustomRefresh) {
              this.startCustomRefreshTimer();
            }
          }
        } else {
          this.log('info', `Keeping requested expires: ${this.actualExpiresTime} seconds (within server limits)`);
        }

      } catch (error) {
        // Safe fallback - keep the initial value
        this.log('warn', `Error extracting server expires: ${error}, keeping initial: ${this.actualExpiresTime} seconds`);
      }
    }, 500); // 500ms delay to allow registration to complete
  }

  /**
   * Start custom refresh timer
   */
  private startCustomRefreshTimer(): void {
    this.stopCustomRefreshTimer(); // Clear any existing timer

    if (!this.useCustomRefresh || !this.sipConfig.customRefreshFrequency) {
      return;
    }

    const refreshInterval = this.calculateRefreshInterval();

    if (this.logConfig.level === 'debug' || this.logConfig.level === 'info') {
      // Only calculate comparison for logging if needed
      const standardFreq = this.sipConfig.sipOptions?.['refreshFrequency'] || 90;
      const requestedExpires = this.sipConfig.registerExpires || 600;
      const effectiveExpires = Math.min(requestedExpires, this.actualExpiresTime);
      const standardInterval = Math.floor(effectiveExpires * (standardFreq / 100));

      this.log('info', `🔄 Custom refresh: ${this.sipConfig.customRefreshFrequency}% = ${refreshInterval}s interval`);
      this.log('info', `🔄 Standard SIP.js would use: ${standardFreq}% = ${standardInterval}s`);
    }

    // Set timer for custom re-registration
    this.log('info', `🔄 Custom refresh timer STARTED - will fire in ${refreshInterval}s`);
    this.customRefreshTimer = setTimeout(() => {
      this.performCustomRefresh();
    }, refreshInterval * 1000) as any;
  }

  /**
   * Calculate refresh interval (cached calculation)
   */
  private calculateRefreshInterval(): number {
    const requestedExpires = this.sipConfig.registerExpires || 600;
    const effectiveExpires = Math.min(requestedExpires, this.actualExpiresTime);
    const refreshFrequency = this.sipConfig.customRefreshFrequency!;
    const refreshInterval = Math.floor(effectiveExpires * (refreshFrequency / 100));

    // Ensure minimum 1 second interval for safety
    return Math.max(1, refreshInterval);
  }

  /**
   * Stop custom refresh timer
   */
  private stopCustomRefreshTimer(): void {
    if (this.customRefreshTimer) {
      this.log('info', '🔄 Custom refresh timer STOPPED');
      clearTimeout(this.customRefreshTimer);
      this.customRefreshTimer = null;
    }
  }

  /**
   * Stop AudioContext notification timer
   */
  private stopAudioContextNotificationTimer(): void {
    if (this.audioContextNotificationTimer) {
      clearTimeout(this.audioContextNotificationTimer);
      this.audioContextNotificationTimer = null;
      this.log('info', '🔔 AudioContext notification timer STOPPED');
    }
  }

  /**
   * Perform custom refresh (manual re-registration)
   */
  private async performCustomRefresh(): Promise<void> {
    if (!this.registered || !this.registerer) {
      this.log('warn', '🔄 Custom refresh timer fired but registration not active - skipping');
      return;
    }

    const refreshFrequency = this.sipConfig.customRefreshFrequency!;
    const effectiveExpires = Math.min(this.sipConfig.registerExpires || 600, this.actualExpiresTime);
    const refreshInterval = this.calculateRefreshInterval();

    try {
      this.log('info', `🔄 CUSTOM REFRESH TIMER FIRED - Performing manual re-registration`);
      this.log('info', `🔄 Custom refresh config: ${refreshFrequency}% of ${effectiveExpires}s = ${refreshInterval}s interval`);
      this.log('info', `🔄 This is ${refreshInterval < 102 ? 'MORE' : 'LESS'} aggressive than SIP.js standard (~102s for 85% of 120s)`);

      // Manually trigger re-registration
      await this.registerer.register();

      this.log('info', '🔄 Custom refresh re-registration completed successfully');

      // Reset failure counter on success
      this.customRefreshFailures = 0;

      // Manually restart the timer since re-registrations don't trigger RegistererState.Registered
      this.log('info', `🔄 Restarting custom refresh timer for next cycle`);
      this.startCustomRefreshTimer();
    } catch (error: any) {
      this.customRefreshFailures++;
      this.log('error', `🔄 Custom refresh FAILED (attempt ${this.customRefreshFailures}/${this.maxCustomRefreshFailures}): ${error.message}`);

      // If too many failures, fall back to SIP.js auto-refresh
      if (this.customRefreshFailures >= this.maxCustomRefreshFailures) {
        this.log('warn', `🔄 Custom refresh failed ${this.maxCustomRefreshFailures} times, falling back to SIP.js auto-refresh`);
        this.useCustomRefresh = false;

        // Recreate registerer with standard refresh
        this.recreateRegistererWithStandardRefresh();
        return;
      }

      // Exponential backoff for retry
      const baseInterval = this.calculateRefreshInterval();
      const backoffMultiplier = Math.pow(2, this.customRefreshFailures - 1);
      const retryInterval = Math.min(baseInterval * backoffMultiplier, 300); // Max 5 minutes

      this.log('info', `🔄 Retrying custom refresh in ${retryInterval}s (backoff: ${backoffMultiplier}x)`);

      this.customRefreshTimer = setTimeout(() => {
        this.performCustomRefresh();
      }, retryInterval * 1000) as any;
    }
  }

  /**
   * Recreate registerer with standard refresh frequency
   */
  private async recreateRegistererWithStandardRefresh(): Promise<void> {
    if (!this.userAgent || !this.registerer) return;

    try {
      // Dispose current registerer
      this.registerer.dispose();

      // Create new registerer with standard refresh
      const standardRefreshFrequency = Math.max(50, this.sipConfig.sipOptions?.['refreshFrequency'] || 90);

      this.registerer = new Registerer(this.userAgent, {
        expires: this.sipConfig.registerExpires || 600,
        refreshFrequency: standardRefreshFrequency,
      });

      // Re-setup event listeners (reuse existing logic)
      this.setupRegistererListeners();

      // Re-register
      await this.registerer.register();

      this.log('info', `Fallback to SIP.js auto-refresh at ${standardRefreshFrequency}%`);
    } catch (error: any) {
      this.log('error', `Failed to recreate registerer: ${error.message}`);
    }
  }

  /**
   * Setup registerer event listeners (extracted for reuse)
   */
  private setupRegistererListeners(): void {
    if (!this.registerer) return;

    this.registerer.stateChange.addListener((state) => {
      switch (state) {
        case RegistererState.Registered:
          this.registered = true;
          this.log('info', 'SIP registered successfully');

          // Extract actual expires from server response
          this.extractActualExpires();

          // Start custom refresh timer if enabled
          if (this.useCustomRefresh) {
            this.startCustomRefreshTimer();
          }

          this.broadcastRegistrationState(true);
          break;
        case RegistererState.Unregistered:
          this.registered = false;
          this.log('info', 'SIP unregistered');
          this.stopCustomRefreshTimer();
          this.stopAudioContextNotificationTimer();
          this.broadcastRegistrationState(false);
          break;
        default:
          break;
      }
    });
  }
}
