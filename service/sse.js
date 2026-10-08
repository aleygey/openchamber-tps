/** Streaming SSE parser: accepts LF/CRLF split across arbitrary TCP chunks. */
export class SseParser {
  constructor(onEvent, limit = 1048576) {
    this.onEvent = onEvent;
    this.limit = limit;
    this.decoder = new TextDecoder();
    this.line = '';
    this.data = [];
    this.size = 0;
    this.afterCR = false;
  }
  feed(bytes) {
    for (const ch of this.decoder.decode(bytes, { stream: true })) {
      if (this.afterCR) {
        this.afterCR = false;
        if (ch === '\n') continue;
      }
      if (ch === '\r' || ch === '\n') {
        this.finishLine();
        this.afterCR = ch === '\r';
      } else {
        this.line += ch;
        this.size++;
        if (this.size > this.limit) throw new Error('SSE_FRAME_TOO_LARGE');
      }
    }
  }
  finishLine() {
    if (this.line === '') {
      if (this.data.length) {
        let value;
        try { value = JSON.parse(this.data.join('\n')); } catch { value = null; }
        if (value && typeof value === 'object') this.onEvent(value);
      }
      this.data = [];
      this.size = 0;
    } else if (this.line.startsWith('data:')) {
      this.data.push(this.line.slice(5).replace(/^ /, ''));
    }
    this.line = '';
  }
}
