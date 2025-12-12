/**
 * TabManager - Lớp quản lý các tab kết nối
 */

import { SipWorker } from '../common/types';
import { MessageBroker } from './message-broker';
import { WorkerState } from './worker-state';

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

  /**
   * Callback được gọi khi cần hangup call do tab đóng
   */
  onTabClosedWithCall?: (callId: string, reason: string) => Promise<void>;

  /**
   * Callback được gọi khi AudioContext state thay đổi
   */
  onAudioContextStateChanged?: (hasRunningAudioContext: boolean, previousState: boolean) => void;
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
   * WorkerState để lấy trạng thái hiện tại
   */
  private workerState: WorkerState;

  /**
   * ID của tab đang được chọn để xử lý cuộc gọi
   */
  private selectedTabId: string | null = null;

  /**
   * Trạng thái AudioContext trước đó (để detect thay đổi)
   */
  private previousAudioContextState: boolean = false;

  /**
   * Thời gian chờ tối đa để chọn tab xử lý cuộc gọi (ms)
   */
  private tabSelectionTimeout: number = 5000;

  /**
   * Callback được gọi khi cần hangup call do tab đóng
   */
  private onTabClosedWithCall?: (callId: string, reason: string) => Promise<void>;

  /**
   * Callback được gọi khi AudioContext state thay đổi
   */
  private onAudioContextStateChanged?: (hasRunningAudioContext: boolean, previousState: boolean) => void;

  /**
   * Interval ID for periodic AudioContext monitoring
   */
  private audioContextMonitoringInterval?: NodeJS.Timeout;

  /**
   * Khởi tạo TabManager
   * @param messageBroker MessageBroker để giao tiếp với các tab
   * @param workerState WorkerState để lấy trạng thái hiện tại
   * @param options Tùy chọn khởi tạo
   */
  constructor(messageBroker: MessageBroker, workerState: WorkerState, options?: TabManagerOptions) {
    this.messageBroker = messageBroker;
    this.workerState = workerState;

    if (options?.tabSelectionTimeout !== undefined) {
      this.tabSelectionTimeout = options.tabSelectionTimeout;
    }

    if (options?.onTabClosedWithCall) {
      this.onTabClosedWithCall = options.onTabClosedWithCall;
    }

    if (options?.onAudioContextStateChanged) {
      this.onAudioContextStateChanged = options.onAudioContextStateChanged;
    }

    // Đăng ký các handler xử lý tin nhắn
    this.registerMessageHandlers();
    
    // Start periodic AudioContext state checking
    this.startAudioContextMonitoring();
  }

  /**
   * Đăng ký các handler xử lý tin nhắn
   */
  private registerMessageHandlers(): void {
    // Xử lý tin nhắn đăng ký tab mới
    this.messageBroker.on(SipWorker.MessageType.TAB_REGISTER, async (message, tabId, port) => {
      const tabInfo = message.data as Partial<SipWorker.TabInfo>;
      const result = this.registerTab(tabId, tabInfo);
      
      // STATE_SYNC is now handled by MessageBroker.registerTab()
      // No need to send duplicate state sync here
      
      return result;
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

    // Xử lý tin nhắn cập nhật trạng thái AudioContext
    this.messageBroker.on(SipWorker.MessageType.TAB_UPDATE_AUDIO_CONTEXT, async (message, tabId) => {
      const data = message.data as { audioContextRunning: boolean };
      return this.updateTabAudioContext(tabId, data.audioContextRunning);
    });
  }

  /**
   * Đăng ký tab mới
   * @param tabId ID của tab
   * @param tabInfo Thông tin về tab
   * @returns Object với thông tin tab và flag isNewTab
   */
  public registerTab(tabId: string, tabInfo: Partial<SipWorker.TabInfo>): { tabInfo: SipWorker.TabInfo, isNewTab: boolean } {
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
      
      // Check AudioContext state after tab update (in case audioContextRunning changed)
      this.checkAudioContextStateAndNotify();
      
      return { tabInfo: updatedTab, isNewTab: false };
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
        audioContextRunning: tabInfo.audioContextRunning || false,
        port: tabInfo.port
      };
      
      this.tabs.set(tabId, newTab);
      console.log(`Tab mới đã đăng ký: ${tabId}`);
      
      // Immediately check AudioContext state after new tab registration
      this.checkAudioContextStateAndNotify();
      
      return { tabInfo: newTab, isNewTab: true };
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
    
    // Check if this tab is handling any active calls
    const activeCalls = this.workerState.getActiveCalls();
    const handledCalls = activeCalls.filter(call => call.handlingTabId === tabId);
    
    if (handledCalls.length > 0) {
      console.log(`Tab ${tabId} is handling ${handledCalls.length} active call(s)`);
      console.log(`Waiting 5 seconds for user confirmation dialog...`);
      
      // Delay termination to allow user to respond to confirmation dialog
      // If user cancels, tab stays open and will re-register
      // If user confirms or force-closes, tab won't respond and calls will be terminated
      setTimeout(() => {
        // Check if tab is still gone (didn't re-register)
        if (!this.tabs.has(tabId)) {
          console.log(`Tab ${tabId} confirmed closed, terminating calls`);
          
          // Terminate calls directly via callback
          handledCalls.forEach(async (call) => {
            console.log(`Terminating call ${call.id} due to tab ${tabId} closing`);
            
            if (this.onTabClosedWithCall) {
              try {
                await this.onTabClosedWithCall(call.id, 'Tab closed');
              } catch (error) {
                console.error(`Failed to hangup call ${call.id}:`, error);
              }
            } else {
              console.warn('No onTabClosedWithCall callback registered, call will not be terminated');
            }
          });
        } else {
          console.log(`Tab ${tabId} is still active, user cancelled close - keeping calls`);
        }
      }, 1000); // 1 second delay - enough for re-registration if user cancels
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
    // 1. Tab có quyền media được cấp (HIGHEST PRIORITY)
    // 2. Tab có AudioContext đang chạy
    // 3. Tab đang active
    // 4. Tab đang visible
    // 5. Tab được active gần đây nhất
    // 6. Tab bất kỳ
    
    // Tạo danh sách tab theo thứ tự ưu tiên
    const tabEntries = Array.from(this.tabs.entries());
    
    // Sắp xếp theo thứ tự ưu tiên
    tabEntries.sort(([, a], [, b]) => {
      // 1. Ưu tiên tab có quyền media (HIGHEST PRIORITY)
      if (a.mediaPermission === SipWorker.TabMediaPermission.GRANTED && 
          b.mediaPermission !== SipWorker.TabMediaPermission.GRANTED) {
        return -1;
      }
      if (a.mediaPermission !== SipWorker.TabMediaPermission.GRANTED && 
          b.mediaPermission === SipWorker.TabMediaPermission.GRANTED) {
        return 1;
      }
      
      // 2. Ưu tiên tab có AudioContext đang chạy (SECOND PRIORITY)
      if (a.audioContextRunning && !b.audioContextRunning) {
        return -1;
      }
      if (!a.audioContextRunning && b.audioContextRunning) {
        return 1;
      }
      
      // 3. Ưu tiên tab active
      if (a.state === SipWorker.TabState.ACTIVE && b.state !== SipWorker.TabState.ACTIVE) {
        return -1;
      }
      if (a.state !== SipWorker.TabState.ACTIVE && b.state === SipWorker.TabState.ACTIVE) {
        return 1;
      }
      
      // 4. Ưu tiên tab visible
      if (a.state === SipWorker.TabState.VISIBLE && b.state !== SipWorker.TabState.VISIBLE) {
        return -1;
      }
      if (a.state !== SipWorker.TabState.VISIBLE && b.state === SipWorker.TabState.VISIBLE) {
        return 1;
      }
      
      // 5. Ưu tiên tab được active gần đây nhất
      return b.lastActiveTime - a.lastActiveTime;
    });
    
    // Chọn tab đầu tiên sau khi sắp xếp
    if (tabEntries.length > 0) {
      const [tabId, selectedTab] = tabEntries[0];
      this.selectedTabId = tabId;
      
      // Log thông tin về việc chọn tab
      const reasons = [];
      if (selectedTab.mediaPermission === SipWorker.TabMediaPermission.GRANTED) {
        reasons.push('media permission granted');
      }
      if (selectedTab.audioContextRunning) {
        reasons.push('AudioContext running');
      }
      if (selectedTab.state === SipWorker.TabState.ACTIVE) {
        reasons.push('tab active');
      } else if (selectedTab.state === SipWorker.TabState.VISIBLE) {
        reasons.push('tab visible');
      }
      
      const reasonText = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
      console.log(`Selected tab ${tabId}${reasonText}`);
      
      if (selectedTab.mediaPermission === SipWorker.TabMediaPermission.GRANTED) {
        console.log(`Tab ${tabId} has media permission - optimal for call handling`);
      } else if (selectedTab.audioContextRunning) {
        console.log(`Tab ${tabId} has running AudioContext but no media permission`);
      } else {
        console.log(`Tab ${tabId} selected by fallback criteria - may need media permission`);
      }
      
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
   * Cập nhật trạng thái AudioContext của tab
   * @param tabId ID của tab
   * @param audioContextRunning Trạng thái AudioContext (running/suspended)
   * @returns Thông tin đã được cập nhật về tab
   */
  public updateTabAudioContext(
    tabId: string,
    audioContextRunning: boolean
  ): SipWorker.TabInfo | null {
    // Kiểm tra xem tab có tồn tại không
    const tab = this.tabs.get(tabId);
    
    if (!tab) {
      console.warn(`Tab không tồn tại: ${tabId}`);
      return null;
    }
    
    // Cập nhật trạng thái AudioContext
    tab.audioContextRunning = audioContextRunning;
    console.log(`Tab ${tabId} đã cập nhật trạng thái AudioContext: ${audioContextRunning ? 'running' : 'suspended'}`);
    
    // Immediately check AudioContext state and notify if needed
    this.checkAudioContextStateAndNotify();
    
    return tab;
  }

  /**
   * Kiểm tra và thông báo thay đổi trạng thái AudioContext tổng thể
   */
  private checkAndNotifyAudioContextStateChange(): void {
    const currentState = this.hasTabWithRunningAudioContext();
    
    if (currentState !== this.previousAudioContextState) {
      console.log(`AudioContext state changed: ${this.previousAudioContextState} → ${currentState}`);
      
      // Call callback if registered
      if (this.onAudioContextStateChanged) {
        this.onAudioContextStateChanged(currentState, this.previousAudioContextState);
      }
      
      // Update previous state
      this.previousAudioContextState = currentState;
    }
  }

  /**
   * Kiểm tra xem có tab nào có AudioContext đang chạy không
   */
  private hasTabWithRunningAudioContext(): boolean {
    return Array.from(this.tabs.values()).some(tab => tab.audioContextRunning === true);
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

  /**
   * Start periodic AudioContext monitoring
   * Checks AudioContext state every 10 seconds and triggers notifications if needed
   */
  private startAudioContextMonitoring(): void {
    // Check every 10 seconds
    this.audioContextMonitoringInterval = setInterval(() => {
      this.checkAudioContextStateAndNotify();
    }, 10000);
    
    console.log('AudioContext monitoring started - checking every 10 seconds');
  }

  /**
   * Check current AudioContext state and notify if needed (regardless of previous state)
   */
  private checkAudioContextStateAndNotify(): void {
    const currentState = this.hasTabWithRunningAudioContext();
    
    console.log(`Immediate AudioContext check: hasRunningAudioContext=${currentState}`);
    
    // Always call callback with current state for immediate checks
    if (this.onAudioContextStateChanged) {
      this.onAudioContextStateChanged(currentState, this.previousAudioContextState);
    }
    
    // Don't update previousAudioContextState here to preserve change detection
    // Only update it in checkAndNotifyAudioContextStateChange()
  }

  /**
   * Stop AudioContext monitoring
   */
  public stopAudioContextMonitoring(): void {
    if (this.audioContextMonitoringInterval) {
      clearInterval(this.audioContextMonitoringInterval);
      this.audioContextMonitoringInterval = undefined;
      console.log('AudioContext monitoring stopped');
    }
  }

  /**
   * Cleanup resources
   */
  public cleanup(): void {
    this.stopAudioContextMonitoring();
    this.tabs.clear();
  }


} 