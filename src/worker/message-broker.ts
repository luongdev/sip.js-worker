/**
 * MessageBroker - Lớp xử lý tin nhắn giữa worker và các tab
 */

import { SipWorker } from '../common/types';

/**
 * Interface cho handler xử lý tin nhắn
 */
export interface MessageHandler<T = any> {
  /**
   * Hàm xử lý tin nhắn
   * @param message Tin nhắn cần xử lý
   * @param tabId ID của tab gửi tin nhắn
   * @param port Cổng kết nối đến tab
   * @returns Promise trả về dữ liệu phản hồi hoặc void nếu không cần phản hồi
   */
  (message: SipWorker.Message<T>, tabId: string, port: MessagePort): Promise<any | void>;
}

/**
 * Lớp MessageBroker xử lý việc gửi/nhận tin nhắn giữa worker và các tab
 */
export class MessageBroker {
  /**
   * Map lưu trữ các cổng kết nối đến các tab theo ID
   */
  private ports: Map<string, MessagePort> = new Map();

  /**
   * Map lưu trữ các handler xử lý tin nhắn theo loại tin nhắn
   */
  private handlers: Map<SipWorker.MessageType, Set<MessageHandler>> = new Map();

  /**
   * Map lưu trữ các promise đang chờ phản hồi theo ID tin nhắn
   */
  private pendingResponses: Map<string, {
    resolve: (value: any) => void,
    reject: (error: any) => void,
    timeout: NodeJS.Timeout
  }> = new Map();

  /**
   * Thời gian timeout mặc định cho các yêu cầu (ms)
   */
  private defaultTimeout: number = 30000;

  /**
   * Khởi tạo MessageBroker
   * @param timeout Thời gian timeout cho các yêu cầu (ms)
   */
  constructor(timeout?: number) {
    if (timeout !== undefined) {
      this.defaultTimeout = timeout;
    }
  }

  /**
   * Đăng ký một tab mới với MessageBroker
   * @param tabId ID của tab
   * @param port Cổng kết nối đến tab
   */
  public registerTab(tabId: string, port: MessagePort): void {
    // Đăng ký tab mới
    this.ports.set(tabId, port);

    // Thiết lập handler xử lý tin nhắn từ tab
    port.onmessage = (event: MessageEvent) => {
      this.handleIncomingMessage(event.data, tabId, port);
    };

    // Thiết lập handler xử lý khi tab đóng kết nối
    port.onmessageerror = () => {
      this.unregisterTab(tabId);
    };

    // Gửi tin nhắn xác nhận đăng ký thành công
    this.sendToTab(tabId, {
      type: SipWorker.MessageType.WORKER_READY,
      id: `worker-ready-${Date.now()}`,
      timestamp: Date.now()
    });

    console.log(`Tab đã đăng ký: ${tabId}`);
  }

  /**
   * Hủy đăng ký một tab
   * @param tabId ID của tab cần hủy đăng ký
   */
  public unregisterTab(tabId: string): void {
    const port = this.ports.get(tabId);
    
    if (port) {
      try {
        // Đóng kết nối
        port.close();
      } catch (error) {
        console.error(`Lỗi khi đóng kết nối với tab ${tabId}:`, error);
      }

      // Xóa khỏi danh sách
      this.ports.delete(tabId);
      console.log(`Tab đã hủy đăng ký: ${tabId}`);
    }
  }

  /**
   * Đăng ký một handler xử lý tin nhắn
   * @param type Loại tin nhắn cần xử lý
   * @param handler Hàm xử lý tin nhắn
   * @returns Hàm để hủy đăng ký handler
   */
  public on<T = any>(type: SipWorker.MessageType, handler: MessageHandler<T>): () => void {
    // Tạo Set nếu chưa có
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }

    // Thêm handler vào Set
    const handlersSet = this.handlers.get(type)!;
    handlersSet.add(handler);

    // Trả về hàm để hủy đăng ký
    return () => {
      handlersSet.delete(handler);
      if (handlersSet.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  /**
   * Đăng ký một handler xử lý tin nhắn một lần duy nhất
   * @param type Loại tin nhắn cần xử lý
   * @param handler Hàm xử lý tin nhắn
   * @returns Promise sẽ resolve khi handler được gọi
   */
  public once<T = any, R = any>(type: SipWorker.MessageType, handler: MessageHandler<T>): Promise<R> {
    return new Promise((resolve) => {
      const onceHandler: MessageHandler<T> = async (message, tabId, port) => {
        // Gọi handler gốc
        const result = await handler(message, tabId, port);
        
        // Hủy đăng ký sau khi xử lý xong
        unsubscribe();
        
        // Resolve promise
        resolve(result as R);
        
        return result;
      };
      
      // Đăng ký handler tạm thời
      const unsubscribe = this.on(type, onceHandler);
    });
  }

  /**
   * Gửi tin nhắn đến một tab cụ thể
   * @param tabId ID của tab nhận tin nhắn
   * @param message Tin nhắn cần gửi
   * @returns Promise sẽ resolve khi tin nhắn được gửi thành công
   */
  public sendToTab(tabId: string, message: SipWorker.Message): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.ports.get(tabId);
      
      if (!port) {
        reject(new Error(`Tab không tồn tại: ${tabId}`));
        return;
      }
      
      try {
        // Gửi tin nhắn
        port.postMessage(message);
        resolve();
      } catch (error) {
        console.error(`Lỗi khi gửi tin nhắn đến tab ${tabId}:`, error);
        
        // Nếu có lỗi, có thể tab đã đóng
        this.unregisterTab(tabId);
        reject(error);
      }
    });
  }

  /**
   * Gửi tin nhắn đến tất cả các tab đã đăng ký
   * @param message Tin nhắn cần gửi
   * @param excludeTabId ID của tab không muốn gửi (tùy chọn)
   * @returns Promise sẽ resolve khi tin nhắn được gửi đến tất cả các tab
   */
  public broadcast(message: SipWorker.Message, excludeTabId?: string): Promise<void[]> {
    const promises: Promise<void>[] = [];
    
    // Gửi tin nhắn đến từng tab
    for (const [tabId, port] of this.ports.entries()) {
      // Bỏ qua tab được chỉ định
      if (excludeTabId && tabId === excludeTabId) {
        continue;
      }
      
      // Thêm promise vào danh sách
      promises.push(this.sendToTab(tabId, message));
    }
    
    // Trả về promise kết hợp
    return Promise.all(promises);
  }

  /**
   * Gửi yêu cầu đến một tab và chờ phản hồi
   * @param tabId ID của tab nhận yêu cầu
   * @param message Tin nhắn yêu cầu
   * @param timeout Thời gian timeout (ms)
   * @returns Promise sẽ resolve với phản hồi từ tab
   */
  public request<T = any, R = any>(
    tabId: string,
    message: SipWorker.Message<T>,
    timeout?: number
  ): Promise<SipWorker.Message<R>> {
    return new Promise((resolve, reject) => {
      const requestId = message.id;
      const actualTimeout = timeout || this.defaultTimeout;
      
      // Thiết lập timeout
      const timeoutId = setTimeout(() => {
        // Xóa khỏi danh sách đang chờ
        this.pendingResponses.delete(requestId);
        
        // Reject promise với lỗi timeout
        reject(new Error(`Yêu cầu timeout sau ${actualTimeout}ms: ${requestId}`));
      }, actualTimeout);
      
      // Lưu promise vào danh sách đang chờ
      this.pendingResponses.set(requestId, {
        resolve,
        reject,
        timeout: timeoutId
      });
      
      // Gửi yêu cầu
      this.sendToTab(tabId, message).catch((error) => {
        // Xóa khỏi danh sách đang chờ
        clearTimeout(timeoutId);
        this.pendingResponses.delete(requestId);
        
        // Reject promise với lỗi gửi
        reject(error);
      });
    });
  }

  /**
   * Xử lý tin nhắn đến từ tab (public method)
   * @param message Tin nhắn cần xử lý
   * @param tabId ID của tab gửi tin nhắn
   * @param port Cổng kết nối đến tab
   */
  public async processMessage(
    message: SipWorker.Message,
    tabId: string,
    port: MessagePort
  ): Promise<void> {
    return this.handleIncomingMessage(message, tabId, port);
  }

  /**
   * Xử lý tin nhắn đến từ tab
   * @param message Tin nhắn cần xử lý
   * @param tabId ID của tab gửi tin nhắn
   * @param port Cổng kết nối đến tab
   */
  private async handleIncomingMessage(
    message: SipWorker.Message,
    tabId: string,
    port: MessagePort
  ): Promise<void> {
    try {
      console.log(`Nhận tin nhắn từ tab ${tabId}:`, message.type);

      // Kiểm tra xem có phải là phản hồi cho yêu cầu nào không
      if (message.id && message.id.startsWith('response-')) {
        const requestId = message.id.replace('response-', '');
        const pendingRequest = this.pendingResponses.get(requestId);
        
        if (pendingRequest) {
          // Xóa khỏi danh sách đang chờ
          clearTimeout(pendingRequest.timeout);
          this.pendingResponses.delete(requestId);
          
          // Resolve hoặc reject promise tùy thuộc vào kết quả
          if (message.error) {
            pendingRequest.reject(new Error(message.error.message));
          } else {
            pendingRequest.resolve(message);
          }
          
          return;
        }
      }

      // Lấy danh sách handler cho loại tin nhắn này
      const handlers = this.handlers.get(message.type);
      
      if (handlers && handlers.size > 0) {
        // Gọi tất cả các handler
        const promises = Array.from(handlers).map(handler => {
          try {
            return handler(message, tabId, port);
          } catch (error) {
            console.error(`Lỗi khi xử lý tin nhắn ${message.type}:`, error);
            return Promise.reject(error);
          }
        });
        
        // Chờ tất cả các handler xử lý xong
        const results = await Promise.allSettled(promises);
        
        // Tìm kết quả đầu tiên không phải là undefined để trả về
        const successResult = results.find(result => 
          result.status === 'fulfilled' && result.value !== undefined
        );
        
        // Nếu có kết quả và tin nhắn yêu cầu phản hồi
        if (successResult && message.id) {
          // Tạo tin nhắn phản hồi
          const response: SipWorker.Message = {
            type: message.type,
            id: `response-${message.id}`,
            timestamp: Date.now(),
            data: (successResult as PromiseFulfilledResult<any>).value
          };
          
          // Gửi phản hồi
          await this.sendToTab(tabId, response);
        }
      } else {
        console.warn(`Không có handler cho tin nhắn ${message.type}`);
        
        // Nếu tin nhắn yêu cầu phản hồi, gửi lỗi
        if (message.id) {
          const errorResponse: SipWorker.Message = {
            type: message.type,
            id: `response-${message.id}`,
            timestamp: Date.now(),
            error: {
              code: 'NO_HANDLER',
              message: `Không có handler cho tin nhắn ${message.type}`
            }
          };
          
          await this.sendToTab(tabId, errorResponse);
        }
      }
    } catch (error) {
      console.error(`Lỗi khi xử lý tin nhắn từ tab ${tabId}:`, error);
    }
  }

  /**
   * Lấy danh sách ID của tất cả các tab đã đăng ký
   * @returns Mảng ID của các tab
   */
  public getTabIds(): string[] {
    return Array.from(this.ports.keys());
  }

  /**
   * Kiểm tra xem một tab có tồn tại không
   * @param tabId ID của tab cần kiểm tra
   * @returns true nếu tab tồn tại, false nếu không
   */
  public hasTab(tabId: string): boolean {
    return this.ports.has(tabId);
  }

  /**
   * Lấy số lượng tab đã đăng ký
   * @returns Số lượng tab
   */
  public getTabCount(): number {
    return this.ports.size;
  }
} 