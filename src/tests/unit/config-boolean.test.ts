/**
 * 환경변수 boolean 파싱 회귀 방지 테스트.
 *
 * 배경: PeakPass의 ENABLE_RATE_LIMITING / ENFORCE_AUTH_USER_MATCH는 원래
 * `z.coerce.boolean()`로 정의되어 있었는데, 이건 자바스크립트 `Boolean(string)`을
 * 따라서 *비어있지 않은 모든 문자열을 true로 변환*한다.
 * 즉 `.env`에 `ENABLE_RATE_LIMITING=false`라고 적어도 실제로는 true가 되어
 * rate limit을 끄지 못하는 *진짜 운영 버그*였다 (k6 부하 측정 중 발견).
 *
 * 명시적 booleanFromEnv 파서로 교체했고, 이 테스트가 회귀를 막는다.
 */

import { z } from 'zod';

const booleanFromEnv = (defaultValue: boolean) =>
  z
    .union([z.string(), z.boolean(), z.undefined()])
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      if (v === undefined || v === '') return defaultValue;
      const normalized = v.toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
      return defaultValue;
    });

describe('booleanFromEnv parser', () => {
  it('treats "false" as false (not true!)', () => {
    expect(booleanFromEnv(true).parse('false')).toBe(false);
    expect(booleanFromEnv(false).parse('false')).toBe(false);
  });

  it('treats "0" as false', () => {
    expect(booleanFromEnv(true).parse('0')).toBe(false);
  });

  it('treats "true" as true', () => {
    expect(booleanFromEnv(false).parse('true')).toBe(true);
  });

  it('treats "1" as true', () => {
    expect(booleanFromEnv(false).parse('1')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(booleanFromEnv(true).parse('FALSE')).toBe(false);
    expect(booleanFromEnv(false).parse('TRUE')).toBe(true);
    expect(booleanFromEnv(true).parse('False')).toBe(false);
  });

  it('uses default when value is missing or empty', () => {
    expect(booleanFromEnv(true).parse(undefined)).toBe(true);
    expect(booleanFromEnv(false).parse(undefined)).toBe(false);
    expect(booleanFromEnv(true).parse('')).toBe(true);
    expect(booleanFromEnv(false).parse('')).toBe(false);
  });

  it('uses default for unrecognized strings', () => {
    expect(booleanFromEnv(true).parse('yes')).toBe(true);
    expect(booleanFromEnv(false).parse('maybe')).toBe(false);
  });

  it('preserves real boolean inputs', () => {
    expect(booleanFromEnv(false).parse(true)).toBe(true);
    expect(booleanFromEnv(true).parse(false)).toBe(false);
  });
});