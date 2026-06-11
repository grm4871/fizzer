-- -------------------------------------------------
-- Seed data – ONLY system users
-- Uses create_profile() for full setup (spaces, jackets, gallery).
-- -------------------------------------------------

SELECT create_profile(
    'netaris',
    'Netaris System',
    '$2b$10$HCNO0mhrwuX6wYc4NwEjhOJNoZgL/cNLnTfvbHggKfYw6VIIDlE6.',
    '00000000-0000-0000-0000-000000000001'::UUID
);

SELECT create_profile(
    'diego',
    'diego',
    '$2b$10$hE.ZdDKNqjE2vBFI9.SmOulBEs1CDvBbcgLyLDgl8c7txA2E0gWHm',
    '00000000-0000-0000-0000-000000000002'::UUID
);

SELECT create_profile(
    'bridgebot',
    'IRC Bridge Bot',
    '$2b$10$XnIXXedPP70KRm35wuNJVeLR00L9hiW1FA6bvPZE4PyRgvSRIAWbC',
    '99999999-9999-9999-9999-999999999999'::UUID
);

-- Ensure system account is always admin
UPDATE profile SET is_admin = TRUE WHERE id = '00000000-0000-0000-0000-000000000000';