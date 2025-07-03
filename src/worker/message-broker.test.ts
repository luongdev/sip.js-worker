/**
 * Test cho MessageBroker
 */

import { MessageBroker } from './message-broker';
import { SipWorker } from '../common/types';

/**
 * Mock cho MessagePort
 */
class MockMessagePort implements MessagePort {
  onmessage: ((this: MessagePort, ev: MessageEvent) => any) | null = null;
  onmessageerror: ((this: MessagePort, ev: MessageEvent) => any) | null = null;
  
  // Lưu trữ tin nhắn đã gửi
  sentMessages: any[] = [];
  
  // Mô phỏng việc gửi tin nhắn
  postMessage(message: any): void {
    this.sentMessages.push(message);
  }
  
  // Mô phỏng việc nhận tin nhắn
  simulateMessage(message: any): void {
    if (this.onmessage) {
      this.onmessage.call(this, new MessageEvent('message', { data: message }));
    }
  }
  
  // Mô phỏng việc đóng kết nối
  close(): void {
    // Không cần làm gì
  }
  
  // Các phương thức khác của MessagePort interface
  start(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return true; }
}

/**
 * Hàm test chính
 */
async function runTests() {
  console.log('Bắt đầu kiểm tra MessageBroker...');
  
  // Tạo instance MessageBroker
  const broker = new MessageBroker(1000); // timeout 1000ms
  
  // Tạo mock MessagePort
  const port1 = new MockMessagePort();
  const port2 = new MockMessagePort();
  
  // Test 1: Đăng ký tab
  console.log('\nTest 1: Đăng ký tab');
  broker.registerTab('tab-1', port1 as unknown as MessagePort);
  broker.registerTab('tab-2', port2 as unknown as MessagePort);
  
  console.assert(broker.getTabCount() === 2, 'Số lượng tab phải là 2');
  console.assert(broker.hasTab('tab-1'), 'Tab 1 phải tồn tại');
  console.assert(broker.hasTab('tab-2'), 'Tab 2 phải tồn tại');
  console.assert(!broker.hasTab('tab-3'), 'Tab 3 không được tồn tại');
  
  console.log('✓ Đăng ký tab thành công');
  
  // Test 2: Gửi tin nhắn đến tab cụ thể
  console.log('\nTest 2: Gửi tin nhắn đến tab cụ thể');
  const message1: SipWorker.Message = {
    type: SipWorker.MessageType.LOG,
    id: 'test-message-1',
    timestamp: Date.now(),
    data: { message: 'Test message' }
  };
  
  await broker.sendToTab('tab-1', message1);
  
  console.assert(port1.sentMessages.length === 2, 'Tab 1 phải nhận được 2 tin nhắn (WORKER_READY và LOG)');
  console.assert(port1.sentMessages[1].id === 'test-message-1', 'ID tin nhắn phải khớp');
  console.assert(port1.sentMessages[1].type === SipWorker.MessageType.LOG, 'Loại tin nhắn phải khớp');
  console.assert(port2.sentMessages.length === 1, 'Tab 2 chỉ nhận được 1 tin nhắn (WORKER_READY)');
  
  console.log('✓ Gửi tin nhắn đến tab cụ thể thành công');
  
  // Test 3: Broadcast tin nhắn
  console.log('\nTest 3: Broadcast tin nhắn');
  const message2: SipWorker.Message = {
    type: SipWorker.MessageType.LOG,
    id: 'test-message-2',
    timestamp: Date.now(),
    data: { message: 'Broadcast message' }
  };
  
  await broker.broadcast(message2);
  
  console.assert(port1.sentMessages.length === 3, 'Tab 1 phải nhận được 3 tin nhắn');
  console.assert(port2.sentMessages.length === 2, 'Tab 2 phải nhận được 2 tin nhắn');
  console.assert(port1.sentMessages[2].id === 'test-message-2', 'ID tin nhắn broadcast phải khớp');
  console.assert(port2.sentMessages[1].id === 'test-message-2', 'ID tin nhắn broadcast phải khớp');
  
  console.log('✓ Broadcast tin nhắn thành công');
  
  // Test 4: Broadcast với exclude
  console.log('\nTest 4: Broadcast với exclude');
  const message3: SipWorker.Message = {
    type: SipWorker.MessageType.LOG,
    id: 'test-message-3',
    timestamp: Date.now(),
    data: { message: 'Broadcast message with exclude' }
  };
  
  await broker.broadcast(message3, 'tab-1');
  
  console.assert(port1.sentMessages.length === 3, 'Tab 1 không được nhận thêm tin nhắn');
  console.assert(port2.sentMessages.length === 3, 'Tab 2 phải nhận được 3 tin nhắn');
  console.assert(port2.sentMessages[2].id === 'test-message-3', 'ID tin nhắn broadcast phải khớp');
  
  console.log('✓ Broadcast với exclude thành công');
  
  // Test 5: Đăng ký handler
  console.log('\nTest 5: Đăng ký handler');
  let handlerCalled = false;
  
  const unsubscribe = broker.on(SipWorker.MessageType.TAB_REGISTER, async (message) => {
    handlerCalled = true;
    return { success: true };
  });
  
  // Giả lập tin nhắn đến
  port1.simulateMessage({
    type: SipWorker.MessageType.TAB_REGISTER,
    id: 'test-register',
    timestamp: Date.now(),
    data: { tabName: 'Test Tab' }
  });
  
  // Chờ một chút để handler được gọi
  await new Promise(resolve => setTimeout(resolve, 100));
  
  console.assert(handlerCalled, 'Handler phải được gọi');
  console.assert(port1.sentMessages.length === 4, 'Tab 1 phải nhận được phản hồi');
  console.assert(port1.sentMessages[3].id === 'response-test-register', 'ID phản hồi phải khớp');
  
  console.log('✓ Đăng ký handler thành công');
  
  // Test 6: Hủy đăng ký handler
  console.log('\nTest 6: Hủy đăng ký handler');
  unsubscribe();
  handlerCalled = false;
  
  // Giả lập tin nhắn đến
  port1.simulateMessage({
    type: SipWorker.MessageType.TAB_REGISTER,
    id: 'test-register-2',
    timestamp: Date.now(),
    data: { tabName: 'Test Tab 2' }
  });
  
  // Chờ một chút để handler được gọi (nếu còn)
  await new Promise(resolve => setTimeout(resolve, 100));
  
  console.assert(!handlerCalled, 'Handler không được gọi sau khi hủy đăng ký');
  console.assert(port1.sentMessages.length === 5, 'Tab 1 phải nhận được phản hồi lỗi');
  console.assert(port1.sentMessages[4].error?.code === 'NO_HANDLER', 'Phải có mã lỗi NO_HANDLER');
  
  console.log('✓ Hủy đăng ký handler thành công');
  
  // Test 7: Hủy đăng ký tab
  console.log('\nTest 7: Hủy đăng ký tab');
  broker.unregisterTab('tab-1');
  
  console.assert(broker.getTabCount() === 1, 'Số lượng tab phải là 1');
  console.assert(!broker.hasTab('tab-1'), 'Tab 1 không được tồn tại');
  console.assert(broker.hasTab('tab-2'), 'Tab 2 phải tồn tại');
  
  // Thử gửi tin nhắn đến tab đã hủy đăng ký
  try {
    await broker.sendToTab('tab-1', message1);
    console.assert(false, 'Gửi tin nhắn đến tab đã hủy đăng ký phải thất bại');
  } catch (error) {
    console.assert(true, 'Gửi tin nhắn đến tab đã hủy đăng ký phải thất bại');
  }
  
  console.log('✓ Hủy đăng ký tab thành công');
  
  // Test 8: Request với timeout
  console.log('\nTest 8: Request với timeout');
  const requestMessage: SipWorker.Message = {
    type: SipWorker.MessageType.MEDIA_REQUEST,
    id: 'test-request',
    timestamp: Date.now(),
    data: { audio: true }
  };
  
  // Gửi request nhưng không phản hồi
  const requestPromise = broker.request('tab-2', requestMessage, 500);
  
  try {
    await requestPromise;
    console.assert(false, 'Request phải timeout');
  } catch (error) {
    console.assert(true, 'Request phải timeout');
    console.log('✓ Request timeout thành công');
  }
  
  // Test 9: Request với phản hồi
  console.log('\nTest 9: Request với phản hồi');
  const requestMessage2: SipWorker.Message = {
    type: SipWorker.MessageType.MEDIA_REQUEST,
    id: 'test-request-2',
    timestamp: Date.now(),
    data: { audio: true }
  };
  
  // Gửi request
  const requestPromise2 = broker.request('tab-2', requestMessage2, 1000);
  
  // Giả lập phản hồi
  setTimeout(() => {
    port2.simulateMessage({
      type: SipWorker.MessageType.MEDIA_REQUEST,
      id: 'response-test-request-2',
      timestamp: Date.now(),
      data: { stream: 'mock-media-stream' }
    });
  }, 100);
  
  try {
    const response = await requestPromise2;
    console.assert(response.data.stream === 'mock-media-stream', 'Dữ liệu phản hồi phải khớp');
    console.log('✓ Request với phản hồi thành công');
  } catch (error) {
    console.assert(false, 'Request không được timeout');
  }
  
  console.log('\nTất cả các test đã hoàn thành!');
}

// Chạy tests
runTests().catch(error => {
  console.error('Lỗi khi chạy tests:', error);
}); 