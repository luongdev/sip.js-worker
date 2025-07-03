/**
 * SipCore - Lớp xử lý SIP signaling
 */

import { SipWorker } from '../common/types';
import { MessageBroker } from './message-broker';
import { TabManager } from './tab-manager';
import { 
  UserAgent, 
  UserAgentOptions, 
  Registerer, 
  RegistererState,
  Inviter,
  Invitation,
  Session,
  SessionState,
  Web
} from 'sip.js';
import { v4 as uuidv4 } from 'uuid';

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
   * Có tự động chấp nhận cuộc gọi đến không
   */
  autoAcceptCalls?: boolean;
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
   * Có tự động chấp nhận cuộc gọi đến không
   */
  private autoAcceptCalls: boolean;

  /**
   * Trạng thái đăng ký SIP
   */
  private registered: boolean = false;

  /**
   * Danh sách các cuộc gọi đang diễn ra
   */
  private activeCalls: Map<string, Session> = new Map();

  /**
   * Khởi tạo SipCore
   * @param messageBroker MessageBroker để giao tiếp với các tab
   * @param tabManager TabManager để quản lý các tab
   * @param options Tùy chọn khởi tạo
   */
  constructor(
    messageBroker: MessageBroker,
    tabManager: TabManager,
    options: SipCoreOptions
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
    this.autoAcceptCalls = options.autoAcceptCalls !== undefined ? options.autoAcceptCalls : false;

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
   * Khởi tạo UserAgent
   */
  private initUserAgent(): void {
    try {
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

      // Tạo cấu hình UserAgent
      const userAgentOptions: UserAgentOptions = {
        uri,
        transportOptions,
        authorizationUsername: this.sipConfig.username,
        authorizationPassword: this.sipConfig.password,
        displayName: this.sipConfig.displayName,
        logBuiltinEnabled: this.logConfig.console,
        logLevel: this.getLogLevel(),
        viaHost: uri.host,
        contactName: this.sipConfig.username,
        sessionDescriptionHandlerFactoryOptions: {
          iceGatheringTimeout: 2000,
          peerConnectionConfiguration: {
            iceServers: this.transportConfig.iceServers
          }
        },
        ...this.sipConfig.sipOptions
      };

      // Tạo UserAgent
      this.userAgent = new UserAgent(userAgentOptions);

      // Thiết lập các sự kiện
      this.setupUserAgentListeners();

      // UserAgent sẽ được start trong register() method
      this.log('info', 'UserAgent initialized successfully');
    } catch (error: any) {
      this.log('error', `Failed to initialize UserAgent: ${error.message}`);
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
      },
      onDisconnect: (error) => {
        this.log('warn', `UserAgent disconnected: ${error ? error.message : 'Unknown reason'}`);
      },
      onInvite: (invitation) => {
        this.handleIncomingCall(invitation);
      }
    };

    // Lắng nghe transport events
    this.userAgent.transport.stateChange.addListener((state) => {
      this.log('info', `Transport state changed to: ${state}`);
    });

    this.userAgent.transport.onConnect = () => {
      this.log('info', 'Transport connected successfully');
    };

    this.userAgent.transport.onDisconnect = (error) => {
      this.log('error', `Transport disconnected: ${error ? error.message : 'Unknown reason'}`);
    };
  }

  /**
   * Xử lý cuộc gọi đến
   * @param invitation Invitation từ SIP.js
   */
  private handleIncomingCall(invitation: Invitation): void {
    // TODO: Implement trong bước tiếp theo
  }

  /**
   * Tạo cuộc gọi đi
   * @param request Thông tin cuộc gọi
   * @returns Promise với kết quả cuộc gọi
   */
  public async makeCall(request: SipWorker.MakeCallRequest): Promise<SipWorker.MakeCallResponse> {
    try {
      // Kiểm tra UserAgent đã được khởi tạo
      if (!this.userAgent) {
        return {
          success: false,
          error: 'UserAgent not initialized'
        };
      }

      // Kiểm tra đã đăng ký SIP
      if (!this.registered) {
        return {
          success: false,
          error: 'SIP not registered'
        };
      }

      // Kiểm tra target URI
      if (!request.targetUri) {
        return {
          success: false,
          error: 'Target URI is required'
        };
      }

      // Tạo URI đích
      const targetUri = UserAgent.makeURI(request.targetUri);
      if (!targetUri) {
        return {
          success: false,
          error: `Invalid target URI: ${request.targetUri}`
        };
      }

      this.log('info', `Making call to: ${request.targetUri}`);

      // Tạo callId duy nhất bằng UUID
      const callId = uuidv4();

      // Tạo extra headers với Call-ID
      const extraHeaders = [
        `Call-ID: ${callId}@${this.sipConfig.uri.replace('sip:', '')}`
      ];

      // Thêm custom headers nếu có
      if (request.extraHeaders) {
        Object.entries(request.extraHeaders).forEach(([key, value]) => {
          extraHeaders.push(`${key}: ${value}`);
        });
      }

      // Tạo Inviter với audio only (no video)
      const inviter = new Inviter(this.userAgent, targetUri, {
        sessionDescriptionHandlerOptions: {
          constraints: {
            audio: true,
            video: false
          }
        }
      });

      // Tạo thông tin cuộc gọi
      const callInfo: SipWorker.CallInfo = {
        id: callId,
        direction: SipWorker.CallDirection.OUTGOING,
        state: SipWorker.CallState.CONNECTING,
        remoteUri: request.targetUri,
        remoteDisplayName: targetUri.toString() || undefined,
        startTime: Date.now()
      };

      // Lưu cuộc gọi vào danh sách
      this.activeCalls.set(callId, inviter);

      // Thiết lập event listeners cho inviter
      this.setupInviterListeners(inviter, callInfo);

      // Gửi INVITE với custom headers
      const inviteResult = await inviter.invite({
        requestOptions: {
          extraHeaders: extraHeaders
        }
      });

      // Broadcast thông tin cuộc gọi đi
      this.broadcastCallStatus(callInfo);

      this.log('info', `Call initiated successfully with ID: ${callId}`);

      return {
        success: true,
        callInfo: callInfo
      };

    } catch (error: any) {
      this.log('error', `Failed to make call: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Thiết lập event listeners cho Inviter
   * @param inviter Inviter instance
   * @param callInfo Thông tin cuộc gọi
   */
  private setupInviterListeners(inviter: Inviter, callInfo: SipWorker.CallInfo): void {
    // Khi nhận được provisional response
    inviter.stateChange.addListener((state) => {
      this.log('info', `Call ${callInfo.id} state changed to: ${state}`);
      
      switch (state) {
        case SessionState.Establishing:
          callInfo.state = SipWorker.CallState.RINGING;
          this.broadcastCallStatus(callInfo);
          break;
        case SessionState.Established:
          callInfo.state = SipWorker.CallState.ESTABLISHED;
          callInfo.establishedTime = Date.now();
          this.broadcastCallStatus(callInfo);
          break;
        case SessionState.Terminated:
          callInfo.state = SipWorker.CallState.TERMINATED;
          callInfo.endTime = Date.now();
          this.activeCalls.delete(callInfo.id);
          this.broadcastCallStatus(callInfo);
          break;
      }
    });

    // Note: SIP.js handles reject events automatically via state changes
    // No need to manually set onReject delegate
  }

  /**
   * Broadcast trạng thái cuộc gọi đến tất cả tabs
   * @param callInfo Thông tin cuộc gọi
   */
  private broadcastCallStatus(callInfo: SipWorker.CallInfo): void {
    this.messageBroker.broadcast({
      type: SipWorker.MessageType.CALL_PROGRESS,
      id: `call-progress-${Date.now()}`,
      timestamp: Date.now(),
      data: callInfo
    });
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
      await this.userAgent.start();
      this.log('info', 'UserAgent started successfully');
    } catch (error: any) {
      this.log('error', `Failed to start UserAgent: ${error.message}`);
      this.broadcastRegistrationFailed(`Failed to start UserAgent: ${error.message}`);
      return { success: false, error: error.message };
    }

    try {
      // Hủy registerer cũ nếu có
      if (this.registerer) {
        this.registerer.dispose();
        this.registerer = null;
      }

      // Tạo Registerer mới
      this.registerer = new Registerer(this.userAgent, {
        expires: this.sipConfig.registerExpires || 600
      });

      // Thiết lập các sự kiện
      this.registerer.stateChange.addListener((state) => {
        switch (state) {
          case RegistererState.Registered:
            this.registered = true;
            this.log('info', 'SIP registered successfully');
            this.broadcastRegistrationState(true);
            break;
          case RegistererState.Unregistered:
            this.registered = false;
            this.log('info', 'SIP unregistered');
            this.broadcastRegistrationState(false);
            break;
          default:
            break;
        }
      });

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
   * Lấy UserAgent
   * @returns UserAgent của SIP.js
   */
  public getUserAgent(): UserAgent | null {
    return this.userAgent;
  }
} 