import { describe, expect, it } from 'vitest';
import { classifyEvent } from './streams.js';
import { parseSseText, SseParser } from './sse.js';

const SAMPLE =
  'id: 1\ndata: {"FixtureId":1,"Seq":1}\n\n' +
  'event: heartbeat\ndata: {"Ts":1752786000}\n\n' +
  'id: 2\ndata: {"FixtureId":1,"Seq":2}\n\n';

describe('SseParser', () => {
  it('parses complete blocks with id/event/data', () => {
    const events = parseSseText(SAMPLE);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ id: '1', data: '{"FixtureId":1,"Seq":1}' });
    expect(events[1]).toEqual({ event: 'heartbeat', data: '{"Ts":1752786000}' });
    expect(events[2]).toEqual({ id: '2', data: '{"FixtureId":1,"Seq":2}' });
  });

  it('is invariant under arbitrary chunk-boundary splits', () => {
    const whole = parseSseText(SAMPLE);
    for (const size of [1, 2, 3, 5, 7, 11]) {
      const parser = new SseParser();
      const events = [];
      for (let i = 0; i < SAMPLE.length; i += size) {
        events.push(...parser.push(SAMPLE.slice(i, i + size)));
      }
      events.push(...parser.end());
      expect(events, `chunk size ${size}`).toEqual(whole);
    }
  });

  it('flushes a trailing event with no terminating blank line', () => {
    const events = parseSseText('id: 9\ndata: {"FixtureId":3}');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ id: '9', data: '{"FixtureId":3}' });
  });

  it('handles CRLF line endings and multi-line data', () => {
    const events = parseSseText('data: line1\r\ndata: line2\r\n\r\n');
    expect(events).toEqual([{ data: 'line1\nline2' }]);
  });

  it('counts comment lines without emitting events', () => {
    const parser = new SseParser();
    const events = [...parser.push(': heartbeat\n\n: ping\n\n'), ...parser.end()];
    expect(events).toEqual([]);
    expect(parser.commentCount).toBe(2);
  });
});

describe('classifyEvent', () => {
  it('passes real records through', () => {
    const rec = classifyEvent({ data: '{"FixtureId":18241006,"Seq":5}', id: '5' });
    expect(rec).toEqual({ FixtureId: 18241006, Seq: 5 });
  });

  it('filters named heartbeat events (their Ts is SECONDS, not ms)', () => {
    expect(classifyEvent({ data: '{"Ts":1752786000}', event: 'heartbeat' })).toBeNull();
  });

  it('filters heartbeat-shaped payloads without FixtureId even when unnamed', () => {
    expect(classifyEvent({ data: '{"Ts":1752786000}' })).toBeNull();
  });

  it('drops unparseable payloads and surfaces them as junk', () => {
    let junk: string | null = null;
    expect(classifyEvent({ data: 'not json' }, (d) => (junk = d))).toBeNull();
    expect(junk).toContain('unparseable');
  });

  it('drops empty data blocks', () => {
    expect(classifyEvent({ data: '' })).toBeNull();
  });
});
