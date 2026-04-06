CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START WITH 1 INCREMENT BY 1;

SELECT setval(
  'ticket_number_seq',
  COALESCE(
    (
      SELECT MAX(
        NULLIF(regexp_replace(ticket_number, '^PASS-[0-9]{4}-', ''), '')::bigint
      )
      FROM tickets
    ),
    0
  ) + 1,
  false
);
