/**
 * SipCore - Lớp xử lý SIP signaling
 */

import { SipWorker } from '../common/types';
import { MessageBroker } from './message-broker';
import { TabManager } from './tab-manager';
import { createWorkerSessionDescriptionHandlerFactory, WorkerSessionDescriptionHandlerOptions } from './worker-session-description-handler';
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
   * @param workerState WorkerState để quản lý trạng thái
   */
  constructor(
    messageBroker: MessageBroker,
    tabManager: TabManager,
    options: SipCoreOptions,
    private workerState?: any // Import sau
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
        authorizationUsername: this.sipConfig.username,
        authorizationPassword: this.sipConfig.password,
        displayName: this.sipConfig.displayName,
        logBuiltinEnabled: this.logConfig.console,
        logLevel: this.getLogLevel(),
        viaHost: uri.host,
        contactName: this.sipConfig.username,
        sessionDescriptionHandlerFactory,
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
    // Lấy Call-ID từ SIP header (chính xác)
    const callId = invitation.request.callId;
    
    this.log('info', `Incoming call received: ${callId} from ${invitation.remoteIdentity.uri}`);
    
    // Tạo thông tin cuộc gọi
    const callInfo: SipWorker.CallInfo = {
      id: callId,
      direction: SipWorker.CallDirection.INCOMING,
      state: SipWorker.CallState.RINGING,
      remoteUri: invitation.remoteIdentity.uri.toString(),
      remoteDisplayName: invitation.remoteIdentity.displayName || undefined,
      startTime: Date.now(),
      isMuted: false,
      isOnHold: false
      // handlingTabId will be set by WorkerSessionDescriptionHandler when tab is selected during accept()
    };
    
    // Lưu cuộc gọi vào danh sách
    this.activeCalls.set(callId, invitation);
    
    // Thiết lập event listeners cho invitation
    this.setupInvitationListeners(invitation, callInfo);
    
    // Update WorkerState với incoming call
    if (this.workerState) {
      this.workerState.setActiveCall(callId, callInfo);
    }

    // Broadcast thông báo cuộc gọi đến
    this.messageBroker.broadcast({
      type: SipWorker.MessageType.CALL_INCOMING,
      id: `incoming-call-${Date.now()}`,
      timestamp: Date.now(),
      data: callInfo
    });
    
    // Nếu có auto accept, tự động chấp nhận cuộc gọi
    if (this.autoAcceptCalls) {
      this.log('info', `Auto-accepting incoming call: ${callId}`);
      this.acceptCall(callId);
    }
  }

  /**
   * Tạo cuộc gọi đi
   * @param request Thông tin cuộc gọi
   * @returns Promise với kết quả cuộc gọi
   */
  public async makeCall(request: SipWorker.MakeCallRequest): Promise<SipWorker.MakeCallResponse> {
    // Tạo callId duy nhất bằng UUID
    const callId = uuidv4();
    
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

      // Thêm custom headers nếu có
      const extraHeaders: string[] = [];
      if (request.extraHeaders) {
        Object.entries(request.extraHeaders).forEach(([key, value]) => {
          extraHeaders.push(`${key}: ${value}`);
        });
      }

      const inviterOptions = {
        sessionDescriptionHandlerOptions: {
          constraints: {
            audio: true,
            video: false
          }
        },

        extraHeaders: extraHeaders,
        params: { callId },
        earlyMedia: true, // Enable early media support
      } as InviterOptions as any;
      
      // Hack: Thêm callId vào sessionDescriptionHandlerOptions để truyền cho factory
      if (inviterOptions.sessionDescriptionHandlerOptions) {
        (inviterOptions.sessionDescriptionHandlerOptions as any).callId = callId;
        console.log('SipCore: Set callId in invite options:', callId);
      }

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
        isOnHold: false
        // handlingTabId will be set by WorkerSessionDescriptionHandler when tab is selected
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
              this.activeCalls.delete(callId);
              
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
          callInfo: callInfo
        };

      } catch (inviteError: any) {
        // Handle invite setup errors (không phải reject responses)
        this.log('error', `Call ${callId} setup failed: ${inviteError.message}`);
        
        // Cleanup
        this.activeCalls.delete(callId);
        
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
          error: inviteError.message || 'Call setup failed'
        };
      }

    } catch (error: any) {
      this.log('error', `Failed to make call: ${error.message}`);
      
      // Cleanup nếu có lỗi
      this.activeCalls.delete(callId);
      
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

      // Chấp nhận cuộc gọi với media constraints
      const acceptOptions = {
        sessionDescriptionHandlerOptions: {
          constraints: {
            audio: true,
            video: false
          }
        }
      };

      // Hack: Thêm callId vào sessionDescriptionHandlerOptions để truyền cho factory
      (acceptOptions.sessionDescriptionHandlerOptions as any).callId = callId;
      console.log('SipCore: Set callId in accept options:', callId);

      await session.accept(acceptOptions);

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
      this.activeCalls.delete(callId);

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

      // Kết thúc session
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

      // Cleanup
      this.activeCalls.delete(callId);

      // Broadcast call terminated event
      this.messageBroker.broadcast({
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
    // Khi trạng thái invitation thay đổi
    invitation.stateChange.addListener((state) => {
      this.log('info', `Incoming call ${callInfo.id} state changed to: ${state}`);
      
      switch (state) {
        case SessionState.Establishing:
          callInfo.state = SipWorker.CallState.CONNECTING;
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
          
          // Broadcast CALL_TERMINATED để reset UI
          this.messageBroker.broadcast({
            type: SipWorker.MessageType.CALL_TERMINATED,
            id: `call-terminated-${Date.now()}`,
            timestamp: Date.now(),
            data: {
              id: callInfo.id,
              state: SipWorker.CallState.TERMINATED,
              endTime: Date.now()
            }
          });
          break;
      }
    });
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
          
          // Trích xuất SIP status code nếu có
          if (inviter.delegate && (inviter.delegate as any).terminateReason) {
            const terminateReason = (inviter.delegate as any).terminateReason;
            if (terminateReason.statusCode) {
              callInfo.statusCode = terminateReason.statusCode;
              callInfo.reasonPhrase = terminateReason.reasonPhrase;
              callInfo.reason = `${terminateReason.statusCode} ${terminateReason.reasonPhrase}`;
            }
          }
          
          this.activeCalls.delete(callInfo.id);
          this.broadcastCallStatus(callInfo);
          
          // Broadcast CALL_TERMINATED để reset UI với SIP status code
          this.messageBroker.broadcast({
            type: SipWorker.MessageType.CALL_TERMINATED,
            id: `call-terminated-${Date.now()}`,
            timestamp: Date.now(),
            data: {
              id: callInfo.id,
              state: SipWorker.CallState.TERMINATED,
              endTime: Date.now(),
              statusCode: callInfo.statusCode,
              reasonPhrase: callInfo.reasonPhrase,
              reason: callInfo.reason
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
    // Update WorkerState
    if (this.workerState) {
      if (callInfo.state === SipWorker.CallState.TERMINATED) {
        this.workerState.removeActiveCall(callInfo.id);
      } else {
        this.workerState.setActiveCall(callInfo.id, callInfo);
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
      if (currentCallInfo) {
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
      if (currentCallInfo) {
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
   * Hold cuộc gọi
   * @param callId ID của cuộc gọi
   * @returns Promise với kết quả
   */
  public async holdCall(callId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const session = this.activeCalls.get(callId);
      if (!session) {
        return { success: false, error: 'Call not found' };
      }

      if (session.state !== SessionState.Established) {
        return { success: false, error: 'Call is not established' };
      }

      this.log('info', `Holding call: ${callId}`);

      // TODO: Implement proper hold via SDP re-negotiation with modifiers
      // For now, just update state without actual SDP manipulation
      // This will be implemented when SessionDescriptionHandlerOptions/Modifiers are ready
      
      this.log('info', `Hold operation simulated for call: ${callId} (SDP re-negotiation not yet implemented)`);

      // Update call state in WorkerState
      const currentCallInfo = this.workerState.getActiveCall(callId);
      if (currentCallInfo) {
        this.workerState.setActiveCall(callId, {
          ...currentCallInfo,
          isOnHold: true
        });
      }

      return { success: true };
    } catch (error: any) {
      this.log('error', `Failed to hold call: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Unhold cuộc gọi
   * @param callId ID của cuộc gọi
   * @returns Promise với kết quả
   */
  public async unholdCall(callId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const session = this.activeCalls.get(callId);
      if (!session) {
        return { success: false, error: 'Call not found' };
      }

      if (session.state !== SessionState.Established) {
        return { success: false, error: 'Call is not established' };
      }

      this.log('info', `Unholding call: ${callId}`);

      // TODO: Implement proper unhold via SDP re-negotiation with modifiers
      // For now, just update state without actual SDP manipulation
      // This will be implemented when SessionDescriptionHandlerOptions/Modifiers are ready
      
      this.log('info', `Unhold operation simulated for call: ${callId} (SDP re-negotiation not yet implemented)`);

      // Update call state in WorkerState
      const currentCallInfo = this.workerState.getActiveCall(callId);
      if (currentCallInfo) {
        this.workerState.setActiveCall(callId, {
          ...currentCallInfo,
          isOnHold: false
        });
      }

      return { success: true };
    } catch (error: any) {
      this.log('error', `Failed to unhold call: ${error.message}`);
      return { success: false, error: error.message };
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
} 