# Supabase Migrations

Run these files **in order** via Supabase SQL Editor or Supabase CLI.

| File | Purpose |
|------|---------|
| `20250622000001_initial_schema.sql` | Creates tables, enums, and indexes |
| `20250622000002_rls_policies.sql` | Enables RLS with permissive policies |
| `20250622000003_seed_data.sql` | Inserts demo salon data |

For a one-shot setup, use `../full_setup.sql` instead.
