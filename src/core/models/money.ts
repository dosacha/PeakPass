import Decimal from 'decimal.js';
import { z } from 'zod';

export const MAX_MONEY_AMOUNT = '99999999.99';

// Match PostgreSQL NUMERIC(10,2) without allowing database rounding.
export const UnitPriceSchema = z.number().finite().min(0.01).max(Number(MAX_MONEY_AMOUNT))
  .refine((price) => new Decimal(price).decimalPlaces() <= 2, 'Price must have at most two decimal places');
