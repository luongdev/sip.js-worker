/**
 * Sửa Content-Length sai trên SIP message nhận từ server.
 *
 * Bối cảnh: rtpengine/proxy phía uatcam.omicx.vn rewrite SDP (dòng `A=rtpengine:...`)
 * nhưng tính lại Content-Length lệch 2 bytes (thiếu 1 CRLF cuối body). sip.js
 * sanity check (user-agent.js:859-863, port của SanityCheck.rfc3261_18_3_response)
 * thấy body ngắn hơn Content-Length → drop toàn bộ response → re-INVITE hold
 * không bao giờ nhận được 200 OK.
 *
 * WebSocket là message-based: frame luôn nguyên vẹn, nên độ dài body thực tế
 * chính là toàn bộ phần sau \r\n\r\n. An toàn khi ghi đè Content-Length >
 * độ dài thực bằng đúng độ dài thực. Trường hợp ngược lại (CL < body) KHÔNG sửa —
 * RFC 3261 18.3 cho phép discard bytes thừa, và đó là hành vi đúng của parser.
 */

/** Header block terminator của SIP message. */
const HEADER_BODY_SEPARATOR = "\r\n\r\n";
/**
 * Match dòng Content-Length (case-insensitive, giữ nguyên dạng khi capture).
 * Không bắt CRLF cuối dòng vì header block đã bị cắt ở separator.
 * KHÔNG dùng flag g ở String.match — flag g tắt capture groups.
 */
const CONTENT_LENGTH_RE = /^([Cc]ontent-[Ll]ength:[ \t]*)(\d+)/m;
/** Bản có flag g để replace. */
const CONTENT_LENGTH_RE_G = /^([Cc]ontent-[Ll]ength:[ \t]*)(\d+)/gm;

/**
 * Ghi đè Content-Length bằng độ dài UTF-8 byte thực của body nếu header khai báo
 * lớn hơn (server gửi thiếu byte). Message hợp lệ được trả về nguyên vẹn.
 *
 * @param message SIP message thô nhận từ WebSocket
 * @returns message đã sửa (hoặc nguyên bản nếu không cần/không thể sửa)
 */
export function fixContentLength(message: string): string {
  if (!message) {
    return message;
  }
  const sepIndex = message.indexOf(HEADER_BODY_SEPARATOR);
  if (sepIndex === -1) {
    // Không có body (keep-alive CRLF, message cụt header...) — không đụng vào.
    return message;
  }
  const headerBlock = message.slice(0, sepIndex);
  const match = headerBlock.match(CONTENT_LENGTH_RE);
  if (!match) {
    return message;
  }
  const declared = Number(match[2]);
  const body = message.slice(sepIndex + HEADER_BODY_SEPARATOR.length);
  // Độ dài UTF-8 byte, đúng cách sip.js tính (core/messages/utils.ts utf8Length).
  const actual = encodeURIComponent(body).replace(/%[A-F\d]{2}/g, "U").length;
  // Chỉ sửa khi header khai báo LỚN HƠN body thực — đó là trường hợp server
  // gửi thiếu byte và sip.js sẽ drop message (sanity check rfc3261_18_3_response).
  // CL nhỏ hơn body: hành vi đúng của parser là discard bytes thừa, không sửa.
  if (declared <= actual) {
    return message;
  }
  const fixedHeaderBlock = headerBlock.replace(
    CONTENT_LENGTH_RE_G,
    (_full, prefix: string, _digits: string) => `${prefix}${actual}`
  );
  return fixedHeaderBlock + HEADER_BODY_SEPARATOR + body;
}
