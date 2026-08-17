-- PRODUCTS-1: salon-scoped inventory. Stock status is derived in the API, not stored.
-- Isolation is enforced in the API via salon_id (service-role / no RLS policies).

CREATE TABLE IF NOT EXISTS public.products (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id             UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  brand                TEXT NOT NULL DEFAULT '',
  line                 TEXT NOT NULL DEFAULT '',
  code_shade           TEXT NOT NULL DEFAULT '',
  category             TEXT NOT NULL DEFAULT '',
  quantity             INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  min_quantity         INTEGER NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  unit                 TEXT NOT NULL DEFAULT '',
  price                NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  supplier             TEXT NOT NULL DEFAULT '',
  marked_for_purchase  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS products_salon_id_idx
  ON public.products (salon_id);

CREATE INDEX IF NOT EXISTS products_salon_name_idx
  ON public.products (salon_id, name);

-- Same brand + line + code/shade cannot repeat inside one salon.
-- Empty identity (all three blank) is allowed more than once.
CREATE UNIQUE INDEX IF NOT EXISTS products_salon_identity_unique
  ON public.products (
    salon_id,
    lower(btrim(brand)),
    lower(btrim(line)),
    lower(btrim(code_shade))
  )
  WHERE btrim(brand) <> '' OR btrim(line) <> '' OR btrim(code_shade) <> '';

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
