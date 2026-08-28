-- Salon display currency: AMD / RUB / USD. Default AMD.
-- Display-only setting — do not convert existing monetary amounts.
ALTER TABLE public.salons
  ALTER COLUMN currency SET DEFAULT 'AMD';
