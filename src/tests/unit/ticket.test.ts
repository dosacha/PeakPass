import { generateTicketNumber } from '@/core/models/ticket';

describe('generateTicketNumber', () => {
  it('formats ticket numbers as PASS-YYYY-000000', () => {
    const result = generateTicketNumber(2);

    expect(result).toMatch(/^PASS-\d{4}-\d{6}$/);
    expect(result.endsWith('000002')).toBe(true);
  });

  it('keeps six-digit sequences unchanged', () => {
    expect(generateTicketNumber(123456)).toMatch(/-123456$/);
  });

  it('uses the current year', () => {
    const year = new Date().getFullYear();

    expect(generateTicketNumber(1)).toContain(`-${year}-`);
  });
});
