-- Additive only. Keep every existing product row and current CRUD/stock/Excel columns.
-- Applied manually in production; kept in-repo as the source of truth. Do not add another migration.
ALTER TABLE products ADD COLUMN volume TEXT;
ALTER TABLE products ADD COLUMN percentage REAL;
ALTER TABLE products ADD COLUMN price_min INTEGER;
ALTER TABLE products ADD COLUMN price_max INTEGER;
ALTER TABLE products ADD COLUMN currency TEXT NOT NULL DEFAULT 'AMD';
