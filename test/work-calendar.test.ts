import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  checkTaskCalendar, checkWorkCalendar, normalizeCalendarBinding, parseWorkCalendar,
  previewTaskCalendar, workCalendarPath,
} from '../src/services/work-calendar.js';
import type { ScheduledTask } from '../src/types.js';
import { readScheduleUpdate } from '../src/cli/schedule-update.js';

// Synthetic fixture only; none of these exceptions claims to be statutory data.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/work-calendar/demo.json', import.meta.url), 'utf8'));
const definition = fixture.calendars.demo;
let root: string;
let previousDataDir: string;
const app = 'calendar_test_bot';
const task = { calendar: 'demo', larkAppId: app, parsed: { kind: 'cron', expr: '0 9 * * *', display: 'daily' } } as ScheduledTask;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-calendar-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = join(root, 'data');
  const file = workCalendarPath(app);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(fixture));
  vi.stubEnv('BOTMUX_SCHEDULE_TIMEZONE', 'Asia/Shanghai');
});
afterEach(() => {
  config.session.dataDir = previousDataDir;
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('local work calendar schema and dates', () => {
  it.each([
    ['2028-01-03T01:00:00Z', 'working', 'work_week', '2028-01-03'],
    ['2028-01-04T01:00:00Z', 'rest', 'rest_date', '2028-01-04'],
    ['2028-01-08T01:00:00Z', 'working', 'work_date', '2028-01-08'],
    ['2028-01-09T01:00:00Z', 'rest', 'rest_week', '2028-01-09'],
    ['2028-01-03T16:00:00Z', 'rest', 'rest_date', '2028-01-04'],
    ['2028-02-29T01:00:00Z', 'working', 'work_week', '2028-02-29'],
    ['2027-12-31T16:00:00Z', 'working', 'work_date', '2028-01-01'],
    ['2029-01-01T01:00:00Z', 'error', 'calendar_out_of_coverage', '2029-01-01'],
    ['2027-12-29T01:00:00Z', 'error', 'calendar_out_of_coverage', '2027-12-29'],
  ])('%s -> %s (%s)', (instant, status, reason, date) => {
    expect(checkWorkCalendar(parseWorkCalendar(definition), 'demo', new Date(instant)))
      .toMatchObject({ status, reason, date, timeZone: 'Asia/Shanghai' });
  });
  it.each([
    { restDates: ['2028-01-08'] }, { workDates: ['2028-02-30'] },
    { restDates: ['2027-02-29'] }, { timeZone: 'Mars/City' }, { workWeek: [7] },
    { workWeek: [1, 1] }, { workDates: ['2029-01-01'] },
    { coverage: { start: '2029-01-01', end: '2028-12-31' } },
  ])('rejects invalid definition %j', patch => {
    expect(() => parseWorkCalendar({ ...definition, ...patch })).toThrow('calendar_invalid');
  });
  it('allows an empty workWeek with explicit work dates', () => {
    expect(checkWorkCalendar(parseWorkCalendar({ ...definition, workWeek: [] }), 'demo', new Date('2028-01-03T01:00:00Z')).status).toBe('rest');
  });
  it.each(['../demo', 'a/b', 'bad name', 42])('rejects invalid binding %j', name => {
    expect(() => normalizeCalendarBinding(name)).toThrow('invalid_calendar_name');
  });
  it('parses CLI calendar updates and clears explicitly', () => {
    expect(readScheduleUpdate(['abcd1234', '--calendar', 'demo'])).toEqual({ calendar: 'demo' });
    expect(readScheduleUpdate(['abcd1234', '--calendar=none', '--prompt', 'hello\n'])).toEqual({ calendar: null, prompt: 'hello\n' });
  });
});

describe('calendar loading, isolation and next eligible trigger', () => {
  it('fails closed for missing/invalid data and remains independent of unbound tasks', () => {
    expect(checkTaskCalendar({ ...task, calendar: undefined })).toBeUndefined();
    expect(checkTaskCalendar({ ...task, calendar: 'absent' })).toMatchObject({ status: 'error', reason: 'calendar_missing' });
    expect(checkTaskCalendar(task, 'different_bot')).toMatchObject({ status: 'error', reason: 'calendar_missing' });
    expect(checkTaskCalendar({ ...task, larkAppId: undefined })).toMatchObject({ reason: 'calendar_scope_missing' });
    writeFileSync(workCalendarPath(app), '{bad json');
    expect(checkTaskCalendar(task)).toMatchObject({ reason: 'calendar_invalid' });
    expect(checkTaskCalendar({ ...task, calendar: undefined })).toBeUndefined();
  });
  it('isolates malformed unrelated profiles', () => {
    writeFileSync(workCalendarPath(app), JSON.stringify({ ...fixture, calendars: { ...fixture.calendars, broken: {} } }));
    expect(checkTaskCalendar(task, app, new Date('2028-01-03T01:00:00Z')).status).toBe('working');
    expect(checkTaskCalendar({ ...task, calendar: 'broken' })).toMatchObject({ reason: 'calendar_invalid' });
  });
  it('rejects a stored once binding at runtime', () => {
    expect(checkTaskCalendar({ ...task, parsed: { kind: 'once', runAt: '2028-01-04T01:00:00Z', display: 'once' } })).toMatchObject({ reason: 'calendar_once_unsupported' });
  });
  it('previews daily makeup dates without inventing weekday cron triggers', () => {
    const now = new Date('2028-01-07T02:00:00Z');
    expect(previewTaskCalendar(task, app, now)?.nextEligibleRunAt).toBe('2028-01-08T01:00:00.000Z');
    expect(previewTaskCalendar({ ...task, parsed: { ...task.parsed, expr: '0 9 * * 1-5' } }, app, now)?.nextEligibleRunAt).toBe('2028-01-10T01:00:00.000Z');
  });
  it('skips a weekday exception and reports missing future coverage', () => {
    expect(previewTaskCalendar(task, app, new Date('2028-01-03T02:00:00Z'))?.nextEligibleRunAt).toBe('2028-01-05T01:00:00.000Z');
    expect(previewTaskCalendar(task, app, new Date('2029-01-01T01:00:00Z'))).toMatchObject({ nextEligibleRunAt: null, calendarCheck: { reason: 'calendar_out_of_coverage' } });
  });
  it('preserves interval phase when jumping over a local rest day', () => {
    const interval = { ...task, parsed: { kind: 'interval' as const, minutes: 17, display: '17m' }, nextRunAt: '2028-01-03T16:03:00Z' };
    expect(previewTaskCalendar(interval, app, new Date('2028-01-03T16:00:00Z'))?.nextEligibleRunAt).toBe('2028-01-04T16:08:00.000Z');
  });
  it('handles DST midnight when scanning minute cron', () => {
    writeFileSync(workCalendarPath(app), JSON.stringify({ version: 1, calendars: { demo: { ...definition, timeZone: 'America/New_York', workWeek: [1] } } }));
    vi.stubEnv('BOTMUX_SCHEDULE_TIMEZONE', 'America/New_York');
    expect(previewTaskCalendar({ ...task, parsed: { ...task.parsed, expr: '* * * * *' } }, app, new Date('2028-03-12T06:00:00Z'))?.nextEligibleRunAt).toBe('2028-03-13T04:00:00.000Z');
  });
});
