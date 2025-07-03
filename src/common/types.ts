/**
 * Các định nghĩa interface và type chung cho cả worker và client
 */

/**
 * Phiên bản của thư viện
 */
export const VERSION = '0.1.0';

/**
 * Namespace để tránh xung đột với các thư viện khác
 */
export namespace SipWorker {
  /**
   * Các loại tin nhắn được trao đổi giữa worker và client
   */
  export enum MessageType {
    // Tin nhắn quản lý tab
    TAB_REGISTER = 'tab_register',           // Đăng ký tab mới
    TAB_UNREGISTER = 'tab_unregister',       // Hủy đăng ký tab
    TAB_UPDATE_STATE = 'tab_update_state',   // Cập nhật trạng thái tab (visible, active)
    TAB_SELECTED = 'tab_selected',           // Tab được chọn để xử lý cuộc gọi

    // Tin nhắn SIP
    SIP_REGISTER = 'sip_register',           // Đăng ký SIP
    SIP_UNREGISTER = 'sip_unregister',       // Hủy đăng ký SIP
    SIP_REGISTERED = 'sip_registered',       // Đã đăng ký SIP thành công
    SIP_UNREGISTERED = 'sip_unregistered',   // Đã hủy đăng ký SIP
    SIP_REGISTRATION_FAILED = 'sip_registration_failed', // Đăng ký SIP thất bại

    // Tin nhắn cuộc gọi
    CALL_INCOMING = 'call_incoming',         // Có cuộc gọi đến
    CALL_OUTGOING = 'call_outgoing',         // Tạo cuộc gọi đi
    CALL_ACCEPTED = 'call_accepted',         // Cuộc gọi được chấp nhận
    CALL_REJECTED = 'call_rejected',         // Cuộc gọi bị từ chối
    CALL_TERMINATED = 'call_terminated',     // Cuộc gọi kết thúc
    CALL_FAILED = 'call_failed',             // Cuộc gọi thất bại

    // Tin nhắn media
    MEDIA_REQUEST = 'media_request',         // Yêu cầu media từ tab
    MEDIA_RESPONSE = 'media_response',       // Phản hồi media từ tab
    MEDIA_ERROR = 'media_error',             // Lỗi media

    // Tin nhắn hệ thống
    WORKER_READY = 'worker_ready',           // Worker đã sẵn sàng
    ERROR = 'error',                         // Lỗi chung
    LOG = 'log'                              // Ghi log
  }

  /**
   * Interface cho định dạng tin nhắn chung giữa worker và client
   */
  export interface Message<T = any> {
    /**
     * Loại tin nhắn
     */
    type: MessageType;

    /**
     * ID tin nhắn để theo dõi và ghép cặp request/response
     */
    id: string;

    /**
     * ID của tab gửi tin nhắn
     */
    tabId?: string;

    /**
     * Timestamp khi tin nhắn được tạo
     */
    timestamp: number;

    /**
     * Dữ liệu của tin nhắn, kiểu phụ thuộc vào loại tin nhắn
     */
    data?: T;

    /**
     * Mã lỗi (nếu có)
     */
    error?: {
      /**
       * Mã lỗi
       */
      code: string | number;
      
      /**
       * Thông báo lỗi
       */
      message: string;
    };
  }

  /**
   * Trạng thái của tab
   */
  export enum TabState {
    /**
     * Tab đang được hiển thị và là tab active
     */
    ACTIVE = 'active',

    /**
     * Tab đang được hiển thị nhưng không phải tab active
     */
    VISIBLE = 'visible',

    /**
     * Tab không được hiển thị (ẩn hoặc thu nhỏ)
     */
    HIDDEN = 'hidden',

    /**
     * Tab đang bị đóng
     */
    CLOSING = 'closing'
  }

  /**
   * Quyền media của tab
   */
  export enum TabMediaPermission {
    /**
     * Chưa yêu cầu quyền
     */
    NOT_REQUESTED = 'not_requested',

    /**
     * Đã được cấp quyền
     */
    GRANTED = 'granted',

    /**
     * Bị từ chối quyền
     */
    DENIED = 'denied',

    /**
     * Đang chờ người dùng quyết định
     */
    PENDING = 'pending'
  }

  /**
   * Interface để lưu thông tin về tab
   */
  export interface TabInfo {
    /**
     * ID duy nhất của tab
     */
    id: string;

    /**
     * Tên của tab (thường là title của trang)
     */
    name?: string;

    /**
     * URL của tab
     */
    url?: string;

    /**
     * Trạng thái hiện tại của tab
     */
    state: TabState;

    /**
     * Thời gian tab được active lần cuối
     */
    lastActiveTime: number;

    /**
     * Thời gian tab được tạo
     */
    createdTime: number;

    /**
     * Quyền media của tab
     */
    mediaPermission: TabMediaPermission;

    /**
     * Có đang xử lý cuộc gọi không
     */
    handlingCall: boolean;

    /**
     * ID của cuộc gọi đang xử lý (nếu có)
     */
    callId?: string;

    /**
     * Cổng kết nối MessagePort đến tab
     * Lưu ý: Trường này chỉ có ý nghĩa trong worker, không được serialize qua message
     */
    port?: MessagePort;
  }

  /**
   * Cấu hình cho SIP.js UserAgent
   */
  export interface SipConfig {
    /**
     * URI của SIP server
     */
    uri: string;

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

    /**
     * Thời gian hết hạn đăng ký (giây)
     */
    registerExpires?: number;

    /**
     * Các header tùy chọn
     */
    extraHeaders?: Record<string, string>;

    /**
     * Các tham số tùy chọn khác cho SIP.js
     */
    sipOptions?: Record<string, any>;
  }

  /**
   * Cấu hình ICE Server
   */
  export interface IceServer {
    /**
     * URLs của ICE server (STUN/TURN)
     */
    urls: string | string[];
    
    /**
     * Tên người dùng cho TURN server (nếu cần)
     */
    username?: string;
    
    /**
     * Mật khẩu cho TURN server (nếu cần)
     */
    credential?: string;
  }

  /**
   * Cấu hình cho WebSocket transport
   */
  export interface TransportConfig {
    /**
     * URI của WebSocket server
     */
    server: string;

    /**
     * Có sử dụng TLS không
     */
    secure?: boolean;

    /**
     * Thời gian kết nối lại khi mất kết nối (ms)
     */
    reconnectionTimeout?: number;

    /**
     * Số lần thử kết nối lại tối đa
     */
    maxReconnectionAttempts?: number;

    /**
     * Cấu hình ICE servers (STUN/TURN)
     */
    iceServers?: IceServer[];
  }

  /**
   * Cấu hình log
   */
  export interface LogConfig {
    /**
     * Mức độ log
     */
    level?: 'debug' | 'info' | 'warn' | 'error' | 'none';

    /**
     * Có gửi log về client không
     */
    sendToClient?: boolean;

    /**
     * Có ghi log ra console không
     */
    console?: boolean;
  }

  /**
   * Interface cho cấu hình worker
   */
  export interface WorkerConfig {
    /**
     * Cấu hình SIP
     */
    sip: SipConfig;

    /**
     * Cấu hình transport
     */
    transport: TransportConfig;

    /**
     * Cấu hình log
     */
    log?: LogConfig;

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

    /**
     * Thời gian chờ tối đa để chọn tab xử lý cuộc gọi (ms)
     */
    tabSelectionTimeout?: number;
  }

  /**
   * Cấu hình media cho client
   */
  export interface MediaConfig {
    /**
     * Cấu hình audio
     */
    audio?: {
      /**
       * Có sử dụng audio không
       */
      enabled: boolean;

      /**
       * Các ràng buộc cho audio
       */
      constraints?: MediaTrackConstraints;

      /**
       * ID của thiết bị đầu vào audio
       */
      inputDeviceId?: string;

      /**
       * ID của thiết bị đầu ra audio
       */
      outputDeviceId?: string;

      /**
       * Có tự động điều chỉnh gain không
       */
      autoGainControl?: boolean;

      /**
       * Có giảm tiếng ồn không
       */
      noiseSuppression?: boolean;

      /**
       * Có hủy tiếng vọng không
       */
      echoCancellation?: boolean;
    };

    /**
     * Có tự động yêu cầu quyền media khi cần không
     */
    autoRequestPermissions?: boolean;

    /**
     * Có tự động hiển thị hộp thoại yêu cầu quyền không
     */
    autoShowPermissionDialog?: boolean;
  }

  /**
   * Cấu hình UI cho client
   */
  export interface UIConfig {
    /**
     * Có hiển thị thông báo không
     */
    notifications?: {
      /**
       * Có hiển thị thông báo khi có cuộc gọi đến không
       */
      incomingCall?: boolean;

      /**
       * Có hiển thị thông báo khi đăng ký SIP thành công không
       */
      registered?: boolean;

      /**
       * Có hiển thị thông báo khi đăng ký SIP thất bại không
       */
      registrationFailed?: boolean;

      /**
       * Có hiển thị thông báo khi có lỗi không
       */
      error?: boolean;
    };

    /**
     * Có phát âm thanh không
     */
    sounds?: {
      /**
       * Có phát âm thanh khi có cuộc gọi đến không
       */
      incomingCall?: boolean;

      /**
       * Có phát âm thanh khi có cuộc gọi đi không
       */
      outgoingCall?: boolean;

      /**
       * Có phát âm thanh khi kết thúc cuộc gọi không
       */
      callEnded?: boolean;
    };

    /**
     * Đường dẫn đến các file âm thanh
     */
    soundFiles?: {
      /**
       * Âm thanh khi có cuộc gọi đến
       */
      incomingCall?: string;

      /**
       * Âm thanh khi có cuộc gọi đi
       */
      outgoingCall?: string;

      /**
       * Âm thanh khi kết thúc cuộc gọi
       */
      callEnded?: string;
    };
  }

  /**
   * Interface cho cấu hình client
   */
  export interface ClientConfig {
    /**
     * Đường dẫn đến worker
     */
    workerPath: string;

    /**
     * Cấu hình media
     */
    media?: MediaConfig;

    /**
     * Cấu hình UI
     */
    ui?: UIConfig;

    /**
     * Có tự động kết nối đến worker khi khởi tạo không
     */
    autoConnect?: boolean;

    /**
     * Có tự động đăng ký tab khi kết nối không
     */
    autoRegisterTab?: boolean;

    /**
     * Có tự động cập nhật trạng thái tab không
     */
    autoUpdateTabState?: boolean;

    /**
     * Thời gian timeout cho các yêu cầu (ms)
     */
    requestTimeout?: number;

    /**
     * ID của tab (nếu không cung cấp sẽ tự động tạo)
     */
    tabId?: string;

    /**
     * Tên của tab (nếu không cung cấp sẽ sử dụng document.title)
     */
    tabName?: string;
  }
} 