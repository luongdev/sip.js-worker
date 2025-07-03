/**
 * TabManager - Lớp quản lý các tab kết nối
 */

import { SipWorker } from '../common/types';
import { MessageBroker } from './message-broker';

/**
 * Interface cho tùy chọn khởi tạo TabManager
 */
export interface TabManagerOptions {
  /**
   * Thời gian timeout cho các yêu cầu (ms)
   */
  requestTimeout?: number;

  /**
   * Thời gian chờ tối đa để chọn tab xử lý cuộc gọi (ms)
   */
  tabSelectionTimeout?: number;
}

/**
 * Lớp TabManager quản lý các tab kết nối
 */
export class TabManager {
  /**
   * Map lưu trữ thông tin về các tab theo ID
   */
  private tabs: Map<string, SipWorker.TabInfo> = new Map();

  /**
   * MessageBroker để giao tiếp với các tab
   */
  private messageBroker: MessageBroker;

  /**
   * ID của tab đang được chọn để xử lý cuộc gọi
   */
  private selectedTabId: string | null = null;

  /**
   * Thời gian chờ tối đa để chọn tab xử lý cuộc gọi (ms)
   */
  private tabSelectionTimeout: number = 5000;

  /**
   * Khởi tạo TabManager
   * @param messageBroker MessageBroker để giao tiếp với các tab
   * @param options Tùy chọn khởi tạo
   */
  constructor(messageBroker: MessageBroker, options?: TabManagerOptions) {
    this.messageBroker = messageBroker;

    if (options?.tabSelectionTimeout !== undefined) {
      this.tabSelectionTimeout = options.tabSelectionTimeout;
    }

    // Đăng ký các handler xử lý tin nhắn
    this.registerMessageHandlers();
  }

  /**
   * Đăng ký các handler xử lý tin nhắn
   */
  private registerMessageHandlers(): void {
    // Xử lý tin nhắn đăng ký tab mới
    this.messageBroker.on(SipWorker.MessageType.TAB_REGISTER, async (message, tabId, port) => {
      const tabInfo = message.data as Partial<SipWorker.TabInfo>;
      return this.registerTab(tabId, tabInfo);
    });

    // Xử lý tin nhắn hủy đăng ký tab
    this.messageBroker.on(SipWorker.MessageType.TAB_UNREGISTER, async (message, tabId) => {
      this.unregisterTab(tabId);
      return { success: true };
    });

    // Xử lý tin nhắn cập nhật trạng thái tab
    this.messageBroker.on(SipWorker.MessageType.TAB_UPDATE_STATE, async (message, tabId) => {
      const data = message.data as { state: SipWorker.TabState };
      return this.updateTabState(tabId, data.state);
    });
  }

  /**
   * Đăng ký tab mới
   * @param tabId ID của tab
   * @param tabInfo Thông tin về tab
   * @returns Thông tin đã được cập nhật về tab
   */
  public registerTab(tabId: string, tabInfo: Partial<SipWorker.TabInfo>): SipWorker.TabInfo {
    // Kiểm tra xem tab đã tồn tại chưa
    const existingTab = this.tabs.get(tabId);
    
    if (existingTab) {
      // Cập nhật thông tin tab hiện có
      const updatedTab: SipWorker.TabInfo = {
        ...existingTab,
        ...tabInfo,
        lastActiveTime: Date.now()
      };
      
      this.tabs.set(tabId, updatedTab);
      console.log(`Tab đã cập nhật: ${tabId}`);
      return updatedTab;
    } else {
      // Tạo thông tin tab mới
      const newTab: SipWorker.TabInfo = {
        id: tabId,
        name: tabInfo.name || 'Unnamed Tab',
        url: tabInfo.url || '',
        state: tabInfo.state || SipWorker.TabState.HIDDEN,
        lastActiveTime: Date.now(),
        createdTime: Date.now(),
        mediaPermission: tabInfo.mediaPermission || SipWorker.TabMediaPermission.NOT_REQUESTED,
        handlingCall: false,
        port: tabInfo.port
      };
      
      this.tabs.set(tabId, newTab);
      console.log(`Tab mới đã đăng ký: ${tabId}`);
      return newTab;
    }
  }

  /**
   * Hủy đăng ký tab
   * @param tabId ID của tab cần hủy đăng ký
   */
  public unregisterTab(tabId: string): void {
    // Kiểm tra xem tab có tồn tại không
    if (!this.tabs.has(tabId)) {
      console.warn(`Tab không tồn tại: ${tabId}`);
      return;
    }
    
    // Nếu tab đang được chọn, hủy chọn
    if (this.selectedTabId === tabId) {
      this.selectedTabId = null;
    }
    
    // Xóa tab khỏi danh sách
    this.tabs.delete(tabId);
    console.log(`Tab đã hủy đăng ký: ${tabId}`);
  }

  /**
   * Cập nhật trạng thái tab
   * @param tabId ID của tab
   * @param stateOrData Trạng thái mới (string) hoặc object chứa state và các thuộc tính khác
   * @returns Thông tin đã được cập nhật về tab
   */
  public updateTabState(
    tabId: string, 
    stateOrData: SipWorker.TabState | { state: SipWorker.TabState; lastActiveTime?: number }
  ): SipWorker.TabInfo | null {
    // Kiểm tra xem tab có tồn tại không
    const tab = this.tabs.get(tabId);
    
    if (!tab) {
      console.warn(`Tab không tồn tại: ${tabId}`);
      return null;
    }
    
    // Xác định state và lastActiveTime từ tham số
    let state: SipWorker.TabState;
    let lastActiveTime: number | undefined;
    
    if (typeof stateOrData === 'string') {
      // Trường hợp truyền vào chỉ là state string
      state = stateOrData;
    } else {
      // Trường hợp truyền vào là object
      state = stateOrData.state;
      lastActiveTime = stateOrData.lastActiveTime;
    }
    
    // Cập nhật trạng thái
    tab.state = state;
    
    // Cập nhật lastActiveTime nếu được cung cấp, hoặc tự động tính nếu tab active
    if (lastActiveTime !== undefined) {
      tab.lastActiveTime = lastActiveTime;
    } else if (state === SipWorker.TabState.ACTIVE) {
      tab.lastActiveTime = Date.now();
    }
    
    // Nếu tab đang đóng, hủy đăng ký
    if (state === SipWorker.TabState.CLOSING) {
      this.unregisterTab(tabId);
      return null;
    }
    
    console.log(`Tab ${tabId} đã cập nhật trạng thái: ${state}`);
    return tab;
  }

  /**
   * Chọn tab tốt nhất để xử lý cuộc gọi
   * @returns Promise với ID của tab được chọn, hoặc null nếu không có tab nào phù hợp
   */
  public async selectBestTab(): Promise<string | null> {
    // Nếu không có tab nào
    if (this.tabs.size === 0) {
      console.warn('Không có tab nào để chọn');
      return null;
    }
    
    // Nếu chỉ có một tab, chọn tab đó
    if (this.tabs.size === 1) {
      const tabId = Array.from(this.tabs.keys())[0];
      this.selectedTabId = tabId;
      await this.notifySelectedTab(tabId);
      return tabId;
    }
    
    // Tìm tab tốt nhất dựa trên các tiêu chí
    // 1. Tab đang active và có quyền media
    // 2. Tab đang visible và có quyền media
    // 3. Tab đang active
    // 4. Tab đang visible
    // 5. Tab được active gần đây nhất
    // 6. Tab bất kỳ
    
    // Tạo danh sách tab theo thứ tự ưu tiên
    const tabEntries = Array.from(this.tabs.entries());
    
    // Sắp xếp theo thứ tự ưu tiên
    tabEntries.sort(([, a], [, b]) => {
      // Ưu tiên tab có quyền media
      if (a.mediaPermission === SipWorker.TabMediaPermission.GRANTED && 
          b.mediaPermission !== SipWorker.TabMediaPermission.GRANTED) {
        return -1;
      }
      if (a.mediaPermission !== SipWorker.TabMediaPermission.GRANTED && 
          b.mediaPermission === SipWorker.TabMediaPermission.GRANTED) {
        return 1;
      }
      
      // Ưu tiên tab active
      if (a.state === SipWorker.TabState.ACTIVE && b.state !== SipWorker.TabState.ACTIVE) {
        return -1;
      }
      if (a.state !== SipWorker.TabState.ACTIVE && b.state === SipWorker.TabState.ACTIVE) {
        return 1;
      }
      
      // Ưu tiên tab visible
      if (a.state === SipWorker.TabState.VISIBLE && b.state !== SipWorker.TabState.VISIBLE) {
        return -1;
      }
      if (a.state !== SipWorker.TabState.VISIBLE && b.state === SipWorker.TabState.VISIBLE) {
        return 1;
      }
      
      // Ưu tiên tab được active gần đây nhất
      return b.lastActiveTime - a.lastActiveTime;
    });
    
    // Chọn tab đầu tiên sau khi sắp xếp
    if (tabEntries.length > 0) {
      const [tabId] = tabEntries[0];
      this.selectedTabId = tabId;
      await this.notifySelectedTab(tabId);
      return tabId;
    }
    
    return null;
  }

  /**
   * Thông báo cho tab được chọn
   * @param tabId ID của tab được chọn
   */
  private async notifySelectedTab(tabId: string): Promise<void> {
    try {
      // Gửi thông báo đến tab được chọn
      await this.messageBroker.sendToTab(tabId, {
        type: SipWorker.MessageType.TAB_SELECTED,
        id: `tab-selected-${Date.now()}`,
        timestamp: Date.now(),
        tabId
      });
      
      console.log(`Đã thông báo cho tab ${tabId} được chọn`);
    } catch (error) {
      console.error(`Lỗi khi thông báo cho tab ${tabId}:`, error);
    }
  }

  /**
   * Lấy tab được chọn để xử lý cuộc gọi
   * @returns Promise với thông tin về tab được chọn, hoặc null nếu không có tab nào được chọn
   */
  public async getSelectedTab(): Promise<SipWorker.TabInfo | null> {
    // Nếu đã có tab được chọn, trả về tab đó
    if (this.selectedTabId && this.tabs.has(this.selectedTabId)) {
      return this.tabs.get(this.selectedTabId)!;
    }
    
    // Nếu chưa có tab được chọn, chọn tab tốt nhất
    const tabId = await this.selectBestTab();
    
    if (tabId) {
      return this.tabs.get(tabId)!;
    }
    
    return null;
  }

  /**
   * Cập nhật quyền media của tab
   * @param tabId ID của tab
   * @param permission Quyền media mới
   * @returns Thông tin đã được cập nhật về tab
   */
  public updateTabMediaPermission(
    tabId: string,
    permission: SipWorker.TabMediaPermission
  ): SipWorker.TabInfo | null {
    // Kiểm tra xem tab có tồn tại không
    const tab = this.tabs.get(tabId);
    
    if (!tab) {
      console.warn(`Tab không tồn tại: ${tabId}`);
      return null;
    }
    
    // Cập nhật quyền media
    tab.mediaPermission = permission;
    console.log(`Tab ${tabId} đã cập nhật quyền media: ${permission}`);
    
    return tab;
  }

  /**
   * Cập nhật trạng thái xử lý cuộc gọi của tab
   * @param tabId ID của tab
   * @param handlingCall Có đang xử lý cuộc gọi không
   * @param callId ID của cuộc gọi (nếu có)
   * @returns Thông tin đã được cập nhật về tab
   */
  public updateTabCallHandling(
    tabId: string,
    handlingCall: boolean,
    callId?: string
  ): SipWorker.TabInfo | null {
    // Kiểm tra xem tab có tồn tại không
    const tab = this.tabs.get(tabId);
    
    if (!tab) {
      console.warn(`Tab không tồn tại: ${tabId}`);
      return null;
    }
    
    // Cập nhật trạng thái xử lý cuộc gọi
    tab.handlingCall = handlingCall;
    tab.callId = callId;
    
    console.log(`Tab ${tabId} đã cập nhật trạng thái xử lý cuộc gọi: ${handlingCall}`);
    
    return tab;
  }

  /**
   * Lấy danh sách tất cả các tab
   * @returns Mảng thông tin về các tab
   */
  public getAllTabs(): SipWorker.TabInfo[] {
    return Array.from(this.tabs.values());
  }

  /**
   * Lấy thông tin về một tab cụ thể
   * @param tabId ID của tab
   * @returns Thông tin về tab, hoặc null nếu tab không tồn tại
   */
  public getTab(tabId: string): SipWorker.TabInfo | null {
    return this.tabs.get(tabId) || null;
  }

  /**
   * Kiểm tra xem một tab có tồn tại không
   * @param tabId ID của tab cần kiểm tra
   * @returns true nếu tab tồn tại, false nếu không
   */
  public hasTab(tabId: string): boolean {
    return this.tabs.has(tabId);
  }

  /**
   * Lấy số lượng tab đã đăng ký
   * @returns Số lượng tab
   */
  public getTabCount(): number {
    return this.tabs.size;
  }
} 