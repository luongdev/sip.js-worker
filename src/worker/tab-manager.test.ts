/**
 * Test cho TabManager
 */

import { TabManager } from './tab-manager';
import { MessageBroker } from './message-broker';
import { SipWorker } from '../common/types';

/**
 * Mock cho MessageBroker
 */
class MockMessageBroker {
  // Lưu trữ các handler đã đăng ký
  handlers: Map<SipWorker.MessageType, Set<any>> = new Map();
  
  // Lưu trữ tin nhắn đã gửi
  sentMessages: Map<string, SipWorker.Message[]> = new Map();
  
  // Mô phỏng phương thức on
  on<T = any>(type: SipWorker.MessageType, handler: any): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    
    const handlersSet = this.handlers.get(type)!;
    handlersSet.add(handler);
    
    return () => {
      handlersSet.delete(handler);
      if (handlersSet.size === 0) {
        this.handlers.delete(type);
      }
    };
  }
  
  // Mô phỏng phương thức sendToTab
  async sendToTab(tabId: string, message: SipWorker.Message): Promise<void> {
    if (!this.sentMessages.has(tabId)) {
      this.sentMessages.set(tabId, []);
    }
    
    this.sentMessages.get(tabId)!.push(message);
  }
  
  // Mô phỏng phương thức broadcast
  async broadcast(message: SipWorker.Message, excludeTabId?: string): Promise<void[]> {
    const promises: Promise<void>[] = [];
    
    // Giả lập gửi tin nhắn đến tất cả tab trừ tab được loại trừ
    for (const tabId of this.sentMessages.keys()) {
      if (excludeTabId && tabId === excludeTabId) {
        continue;
      }
      
      promises.push(this.sendToTab(tabId, message));
    }
    
    return Promise.all(promises);
  }
  
  // Mô phỏng việc gọi handler
  simulateMessage(type: SipWorker.MessageType, message: SipWorker.Message, tabId: string, port: any): Promise<any> {
    const handlers = this.handlers.get(type);
    
    if (handlers && handlers.size > 0) {
      // Gọi handler đầu tiên
      const handler = Array.from(handlers)[0];
      return Promise.resolve(handler(message, tabId, port));
    }
    
    return Promise.resolve(null);
  }
  
  // Xóa tất cả tin nhắn đã gửi
  clearSentMessages(): void {
    this.sentMessages.clear();
  }
}

/**
 * Hàm test chính
 */
async function runTests() {
  console.log('Bắt đầu kiểm tra TabManager...');
  
  // Tạo mock MessageBroker
  const messageBroker = new MockMessageBroker();
  
  // Tạo instance TabManager
  const tabManager = new TabManager(messageBroker as unknown as MessageBroker, {
    tabSelectionTimeout: 1000
  });
  
  // Test 1: Đăng ký tab mới
  console.log('\nTest 1: Đăng ký tab mới');
  const tabInfo1 = tabManager.registerTab('tab-1', {
    name: 'Tab 1',
    url: 'https://example.com/1',
    state: SipWorker.TabState.ACTIVE,
    mediaPermission: SipWorker.TabMediaPermission.GRANTED
  });
  
  console.assert(tabManager.getTabCount() === 1, 'Số lượng tab phải là 1');
  console.assert(tabManager.hasTab('tab-1'), 'Tab 1 phải tồn tại');
  console.assert(tabInfo1.name === 'Tab 1', 'Tên tab phải khớp');
  console.assert(tabInfo1.state === SipWorker.TabState.ACTIVE, 'Trạng thái tab phải khớp');
  console.assert(tabInfo1.mediaPermission === SipWorker.TabMediaPermission.GRANTED, 'Quyền media phải khớp');
  
  console.log('✓ Đăng ký tab mới thành công');
  
  // Test 2: Đăng ký tab thứ hai
  console.log('\nTest 2: Đăng ký tab thứ hai');
  const tabInfo2 = tabManager.registerTab('tab-2', {
    name: 'Tab 2',
    url: 'https://example.com/2',
    state: SipWorker.TabState.VISIBLE,
    mediaPermission: SipWorker.TabMediaPermission.NOT_REQUESTED
  });
  
  console.assert(tabManager.getTabCount() === 2, 'Số lượng tab phải là 2');
  console.assert(tabManager.hasTab('tab-2'), 'Tab 2 phải tồn tại');
  console.assert(tabInfo2.name === 'Tab 2', 'Tên tab phải khớp');
  console.assert(tabInfo2.state === SipWorker.TabState.VISIBLE, 'Trạng thái tab phải khớp');
  
  console.log('✓ Đăng ký tab thứ hai thành công');
  
  // Test 3: Cập nhật tab
  console.log('\nTest 3: Cập nhật tab');
  const updatedTabInfo = tabManager.registerTab('tab-1', {
    name: 'Tab 1 Updated',
    state: SipWorker.TabState.VISIBLE
  });
  
  console.assert(tabManager.getTabCount() === 2, 'Số lượng tab vẫn phải là 2');
  console.assert(updatedTabInfo.name === 'Tab 1 Updated', 'Tên tab phải được cập nhật');
  console.assert(updatedTabInfo.state === SipWorker.TabState.VISIBLE, 'Trạng thái tab phải được cập nhật');
  console.assert(updatedTabInfo.mediaPermission === SipWorker.TabMediaPermission.GRANTED, 'Quyền media không được thay đổi');
  
  console.log('✓ Cập nhật tab thành công');
  
  // Test 4: Cập nhật trạng thái tab
  console.log('\nTest 4: Cập nhật trạng thái tab');
  const updatedState = tabManager.updateTabState('tab-2', SipWorker.TabState.ACTIVE);
  
  console.assert(updatedState !== null, 'Kết quả cập nhật trạng thái không được là null');
  console.assert(updatedState!.state === SipWorker.TabState.ACTIVE, 'Trạng thái tab phải được cập nhật');
  
  const tab2 = tabManager.getTab('tab-2');
  console.assert(tab2!.state === SipWorker.TabState.ACTIVE, 'Trạng thái tab phải được cập nhật trong danh sách');
  
  console.log('✓ Cập nhật trạng thái tab thành công');
  
  // Test 5: Cập nhật quyền media
  console.log('\nTest 5: Cập nhật quyền media');
  const updatedPermission = tabManager.updateTabMediaPermission('tab-2', SipWorker.TabMediaPermission.GRANTED);
  
  console.assert(updatedPermission !== null, 'Kết quả cập nhật quyền media không được là null');
  console.assert(updatedPermission!.mediaPermission === SipWorker.TabMediaPermission.GRANTED, 'Quyền media phải được cập nhật');
  
  const tab2Updated = tabManager.getTab('tab-2');
  console.assert(tab2Updated!.mediaPermission === SipWorker.TabMediaPermission.GRANTED, 'Quyền media phải được cập nhật trong danh sách');
  
  console.log('✓ Cập nhật quyền media thành công');
  
  // Test 6: Chọn tab tốt nhất
  console.log('\nTest 6: Chọn tab tốt nhất');
  const selectedTabId = await tabManager.selectBestTab();
  
  console.assert(selectedTabId === 'tab-2', 'Tab 2 phải được chọn (vì active và có quyền media)');
  console.assert(messageBroker.sentMessages.has('tab-2'), 'Tab 2 phải nhận được thông báo');
  console.assert(messageBroker.sentMessages.get('tab-2')!.length > 0, 'Tab 2 phải nhận được ít nhất một tin nhắn');
  console.assert(messageBroker.sentMessages.get('tab-2')![0].type === SipWorker.MessageType.TAB_SELECTED, 'Tin nhắn phải có loại TAB_SELECTED');
  
  console.log('✓ Chọn tab tốt nhất thành công');
  
  // Test 7: Lấy tab được chọn
  console.log('\nTest 7: Lấy tab được chọn');
  const selectedTab = await tabManager.getSelectedTab();
  
  console.assert(selectedTab !== null, 'Tab được chọn không được là null');
  console.assert(selectedTab!.id === 'tab-2', 'ID của tab được chọn phải khớp');
  
  console.log('✓ Lấy tab được chọn thành công');
  
  // Test 8: Cập nhật trạng thái xử lý cuộc gọi
  console.log('\nTest 8: Cập nhật trạng thái xử lý cuộc gọi');
  const updatedCallHandling = tabManager.updateTabCallHandling('tab-2', true, 'call-123');
  
  console.assert(updatedCallHandling !== null, 'Kết quả cập nhật trạng thái xử lý cuộc gọi không được là null');
  console.assert(updatedCallHandling!.handlingCall === true, 'Trạng thái xử lý cuộc gọi phải được cập nhật');
  console.assert(updatedCallHandling!.callId === 'call-123', 'ID cuộc gọi phải được cập nhật');
  
  const tab2WithCall = tabManager.getTab('tab-2');
  console.assert(tab2WithCall!.handlingCall === true, 'Trạng thái xử lý cuộc gọi phải được cập nhật trong danh sách');
  console.assert(tab2WithCall!.callId === 'call-123', 'ID cuộc gọi phải được cập nhật trong danh sách');
  
  console.log('✓ Cập nhật trạng thái xử lý cuộc gọi thành công');
  
  // Test 9: Hủy đăng ký tab
  console.log('\nTest 9: Hủy đăng ký tab');
  tabManager.unregisterTab('tab-1');
  
  console.assert(tabManager.getTabCount() === 1, 'Số lượng tab phải là 1');
  console.assert(!tabManager.hasTab('tab-1'), 'Tab 1 không được tồn tại');
  console.assert(tabManager.hasTab('tab-2'), 'Tab 2 phải tồn tại');
  
  console.log('✓ Hủy đăng ký tab thành công');
  
  // Test 10: Cập nhật trạng thái tab thành CLOSING
  console.log('\nTest 10: Cập nhật trạng thái tab thành CLOSING');
  tabManager.updateTabState('tab-2', SipWorker.TabState.CLOSING);
  
  console.assert(tabManager.getTabCount() === 0, 'Số lượng tab phải là 0 (tab đã bị hủy đăng ký)');
  console.assert(!tabManager.hasTab('tab-2'), 'Tab 2 không được tồn tại');
  
  console.log('✓ Cập nhật trạng thái tab thành CLOSING thành công');
  
  // Test 11: Chọn tab khi không có tab nào
  console.log('\nTest 11: Chọn tab khi không có tab nào');
  const noSelectedTabId = await tabManager.selectBestTab();
  
  console.assert(noSelectedTabId === null, 'Không có tab nào được chọn');
  
  console.log('✓ Chọn tab khi không có tab nào thành công');
  
  // Test 12: Mô phỏng xử lý tin nhắn từ MessageBroker
  console.log('\nTest 12: Mô phỏng xử lý tin nhắn từ MessageBroker');
  
  // Đăng ký tab mới
  tabManager.registerTab('tab-3', {
    name: 'Tab 3',
    state: SipWorker.TabState.HIDDEN
  });
  
  // Mô phỏng tin nhắn TAB_REGISTER
  const registerMessage: SipWorker.Message = {
    type: SipWorker.MessageType.TAB_REGISTER,
    id: 'test-register',
    timestamp: Date.now(),
    data: {
      name: 'Tab 4',
      state: SipWorker.TabState.ACTIVE
    }
  };
  
  const registerResult = await messageBroker.simulateMessage(
    SipWorker.MessageType.TAB_REGISTER,
    registerMessage,
    'tab-4',
    null
  );
  
  console.assert(registerResult !== null, 'Kết quả đăng ký không được là null');
  console.assert(registerResult.id === 'tab-4', 'ID của tab đăng ký phải khớp');
  console.assert(registerResult.name === 'Tab 4', 'Tên của tab đăng ký phải khớp');
  console.assert(tabManager.getTabCount() === 2, 'Số lượng tab phải là 2');
  
  // Mô phỏng tin nhắn TAB_UPDATE_STATE
  const updateStateMessage: SipWorker.Message = {
    type: SipWorker.MessageType.TAB_UPDATE_STATE,
    id: 'test-update-state',
    timestamp: Date.now(),
    data: {
      state: SipWorker.TabState.VISIBLE
    }
  };
  
  const updateStateResult = await messageBroker.simulateMessage(
    SipWorker.MessageType.TAB_UPDATE_STATE,
    updateStateMessage,
    'tab-4',
    null
  );
  
  console.assert(updateStateResult !== null, 'Kết quả cập nhật trạng thái không được là null');
  console.assert(updateStateResult.state === SipWorker.TabState.VISIBLE, 'Trạng thái tab phải được cập nhật');
  console.assert(tabManager.getTab('tab-4')!.state === SipWorker.TabState.VISIBLE, 'Trạng thái tab phải được cập nhật trong danh sách');
  
  // Mô phỏng tin nhắn TAB_UNREGISTER
  const unregisterMessage: SipWorker.Message = {
    type: SipWorker.MessageType.TAB_UNREGISTER,
    id: 'test-unregister',
    timestamp: Date.now()
  };
  
  const unregisterResult = await messageBroker.simulateMessage(
    SipWorker.MessageType.TAB_UNREGISTER,
    unregisterMessage,
    'tab-4',
    null
  );
  
  console.assert(unregisterResult.success === true, 'Kết quả hủy đăng ký phải thành công');
  console.assert(tabManager.getTabCount() === 1, 'Số lượng tab phải là 1');
  console.assert(!tabManager.hasTab('tab-4'), 'Tab 4 không được tồn tại');
  
  console.log('✓ Mô phỏng xử lý tin nhắn từ MessageBroker thành công');
  
  console.log('\nTất cả các test đã hoàn thành!');
}

// Chạy tests
runTests().catch(error => {
  console.error('Lỗi khi chạy tests:', error);
}); 