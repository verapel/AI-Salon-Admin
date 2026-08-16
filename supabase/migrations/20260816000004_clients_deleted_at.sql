-- Soft-delete clients so cards can leave the active list without
-- deleting appointment history (appointments.client_id is ON DELETE RESTRICT).
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_clients_salon_active
  ON public.clients (salon_id)
  WHERE deleted_at IS NULL;
