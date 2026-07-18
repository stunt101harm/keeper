/**
 * sse.ts — incremental Server-Sent-Events parser.
 *
 * One parser for all three SSE-shaped inputs TxLINE serves:
 *  - the live streams (/scores/stream, /odds/stream),
 *  - the historical endpoint (/scores/historical/{id}) whose response BODY is
 *    SSE-formatted text (data:/id: lines, id == Seq),
 *  - any recorded .sse files.
 *
 * Heartbeats: the live streams send `event: heartbeat` + `data: {"Ts":...}`
 * every ~15s. The parser surfaces them (they feed the idle watchdog); the
 * stream consumer filters them before records reach normalization. NOTE:
 * heartbeat Ts is SECONDS while record Ts is MS — never mix them.
 */

export interface SseEvent {
  /** Joined `data:` payload (multi-line data joined with \n per the SSE spec). */
  data: string;
  /** `id:` field if present — TxLINE sets id == Seq on score streams. */
  id?: string;
  /** `event:` field if present (e.g. "heartbeat"). */
  event?: string;
}

export class SseParser {
  private tail = '';
  private dataLines: string[] = [];
  private id: string | undefined;
  private event: string | undefined;
  /** Comment lines (`: heartbeat`) seen so far — usable as liveness signal. */
  commentCount = 0;

  /** Feed a chunk of text; returns every event completed within it. */
  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = [];
    // The tail holds a possibly-incomplete final line between chunks.
    const lines = (this.tail + chunk).split(/\r\n|\n|\r/);
    this.tail = lines.pop() ?? '';
    for (const line of lines) {
      const ev = this.handleLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  /**
   * Flush a trailing unterminated event. Historical bodies (and a server that
   * closes mid-block) may end without the final blank line — without this,
   * the last record of a match would silently vanish.
   */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.tail !== '') {
      const ev = this.handleLine(this.tail);
      this.tail = '';
      if (ev) events.push(ev);
    }
    const ev = this.dispatch();
    if (ev) events.push(ev);
    return events;
  }

  private handleLine(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) {
      this.commentCount++;
      return null;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1); // spec: strip ONE leading space
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        this.id = value;
        break;
      case 'event':
        this.event = value;
        break;
      default:
        // "retry:" and unknown fields are ignored per the SSE spec.
        break;
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    const hadContent = this.dataLines.length > 0;
    const ev: SseEvent | null = hadContent
      ? {
          data: this.dataLines.join('\n'),
          ...(this.id !== undefined ? { id: this.id } : {}),
          ...(this.event !== undefined ? { event: this.event } : {}),
        }
      : null;
    this.dataLines = [];
    this.id = undefined;
    this.event = undefined;
    return ev;
  }
}

/** Parse a complete SSE-formatted text (historical body, recorded file). */
export function parseSseText(text: string): SseEvent[] {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.end()];
}
