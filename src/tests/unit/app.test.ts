describe('실행 환경', () => {
  it('NODE_ENV 값 유효성 확인', () => {
    expect(process.env.NODE_ENV).toMatch(/^(development|test|production)$/);
  });
});