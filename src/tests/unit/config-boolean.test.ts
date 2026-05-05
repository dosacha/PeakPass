/**
 * 환경변수 boolean 파싱 회귀 방지 테스트.
 *
 * 배경: PeakPass의 ENABLE_RATE_LIMITING / ENFORCE_AUTH_USER_MATCH는 원래
 * `z.coerce.boolean()`로 정의되어 있었는데, 이건 자바스크립트 `Boolean(string)`을
 * 따라서 *빈 문자열을 제외한 모든 string을 true로 변환*한다.
 * 즉 `.env`에 `ENABLE_RATE_LIMITING=false`라고 적어도 실제로는 true가 되어
 * rate limit을 끄지 못하는 *진짜 운영 버그*였다 (k6 부하 측정 중 발견).
 *
 * 명시적 booleanFromEnv 파서로 교체했고, 이 테스트가 회귀를 막는다.
 *
 * 중요: production config.ts의 booleanFromEnv를 *직접 import*해서 검증한다.
 * 이전에는 동일 로직을 inline 재정의해서 테스트했는데, 그러면 production이
 * 다시 `z.coerce.boolean()`으로 회귀해도 테스트는 그대로 통과하는 약점이 있었다.
 */

import { booleanFromEnv } from '@/infra/config';

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
