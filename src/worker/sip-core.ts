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
  Invitation,
  Session,
  URI,
  Web
} from 'sip.js';

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
   */
  private registerMessageHandlers(): void {
    // Handler cho tin nhắn đăng ký SIP
    this.messageBroker.on(SipWorker.MessageType.SIP_REGISTER, async (message) => {
      return this.register();
    });

    // Handler cho tin nhắn hủy đăng ký SIP
    this.messageBroker.on(SipWorker.MessageType.SIP_UNREGISTER, async (message) => {
      return this.unregister();
    });
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

      // Khởi động UserAgent
      this.userAgent.start()
        .then(() => {
          this.log('info', 'UserAgent started successfully');
        })
        .catch((error) => {
          this.log('error', `Failed to start UserAgent: ${error.message}`);
        });
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
  }

  /**
   * Xử lý cuộc gọi đến
   * @param invitation Invitation từ SIP.js
   */
  private handleIncomingCall(invitation: Invitation): void {
    // TODO: Implement trong bước tiếp theo
  }

  /**
   * Đăng ký SIP
   * @returns Kết quả đăng ký
   */
  public async register(): Promise<any> {
    if (!this.userAgent) {
      const error = 'Cannot register: UserAgent not initialized';
      this.log('error', error);
      return { success: false, error };
    }

    try {
      // Tạo Registerer nếu chưa có
      if (!this.registerer) {
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
      }

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