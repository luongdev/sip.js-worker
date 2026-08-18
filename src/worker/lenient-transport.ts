/**
 * Transport WSS khoan dung với Content-Length sai từ server.
 *
 * Lý do tồn tại: xem header comment của fix-content-length.ts.
 *
 * Cách hoạt động: UserAgent gán `transport.onMessage = cb` sau khi tạo transport
 * (sip.js user-agent.ts initTransportCallbacks); class cha đọc `this.onMessage(msg)`
 * trong onWebSocketMessage. Ta thay property đó trên instance bằng getter/setter:
 *  - setter lưu callback gốc của UserAgent
 *  - getter trả về callback bọc fixContentLength — class cha gọi bản đã sửa
 */
import { Web } from 'sip.js';
import { Logger } from 'sip.js/lib/core/log/logger';
import { fixContentLength } from './fix-content-length';

export class LenientTransport extends Web.Transport {
  /** Callback onMessage do UserAgent gán vào (chưa bọc fix). */
  private userAgentOnMessage: ((message: string) => void) | undefined;

  /** Callback bọc fixContentLength — class cha đọc property này để gọi. */
  private wrappedOnMessage: ((message: string) => void) | undefined;

  constructor(logger: Logger, options: any) {
    super(logger, options);
    // KHÔNG khai báo `onMessage` như field/accessor của class — field declaration
    // (useDefineForClassFields) sẽ define property trên instance sau super() và
    // phá defineProperty dưới đây. Định nghĩa trực tiếp trên instance để override
    // field `onMessage` mà class cha khai báo.
    Object.defineProperty(this, 'onMessage', {
      get: () => this.wrappedOnMessage,
      set: (cb: ((message: string) => void) | undefined) => {
        this.userAgentOnMessage = cb;
        this.wrappedOnMessage = cb
          ? (message: string) => cb(fixContentLength(message))
          : undefined;
      },
      configurable: true,
      enumerable: true,
    });
  }
}
