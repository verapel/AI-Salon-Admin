import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { mapClient } from '../lib/mappers.js';
import { getSalonId } from '../lib/salonContext.js';
import { requireSalonWriteAccess } from '../middleware/auth.js';
import { buildClientCreateRow, buildClientUpdate } from '../lib/clientWrite.js';
import {
  draftHasContent,
  emptyImportResult,
  parseClientSpreadsheetBuffer,
  planImportClients,
  reuseFillUpdates,
  sanitizeClientDraft,
  type ClientImportDraft,
  type ClientImportExisting,
} from '../lib/clientImport.js';
import type { Database } from '../types/database.js';

const router = Router();

router.get('/', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('salon_id', salonId)
    .is('deleted_at', null)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapClient));
});

router.get('/:id', async (req, res) => {
  const salonId = getSalonId(req);
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', req.params.id)
    .eq('salon_id', salonId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const built = buildClientCreateRow(req.body, salonId);
  if ('error' in built) return res.status(400).json({ error: built.error });

  const { data, error } = await supabase
    .from('clients')
    .insert(built.row)
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(mapClient(data));
});

router.put('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const built = buildClientUpdate(req.body);
  if ('error' in built) return res.status(400).json({ error: built.error });
  const updates: Database['public']['Tables']['clients']['Update'] = built.updates;

  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/:id/block', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { blockedReason } = req.body ?? {};
  const reason =
    typeof blockedReason === 'string' && blockedReason.trim() ? blockedReason.trim() : null;

  const { data, error } = await supabase
    .from('clients')
    .update({
      is_blocked: true,
      blocked_at: new Date().toISOString(),
      blocked_reason: reason,
    })
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.post('/:id/unblock', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { data, error } = await supabase
    .from('clients')
    .update({
      is_blocked: false,
      blocked_at: null,
      blocked_reason: null,
    })
    .eq('id', id)
    .eq('salon_id', salonId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClient(data));
});

router.delete('/:id', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const id = req.params.id as string;
  const { data, error } = await supabase
    .from('clients')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('salon_id', salonId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Client not found' });
  res.status(204).send();
});

const MAX_IMPORT_BYTES = 6 * 1024 * 1024;

function decodeBase64File(body: { filename?: string; mimeType?: string; contentBase64?: string }) {
  const contentBase64 = String(body.contentBase64 ?? '').replace(/^data:[^;]+;base64,/, '');
  if (!contentBase64) return { error: 'File content is required' as const };
  if (contentBase64.length > MAX_IMPORT_BYTES * 2) return { error: 'File is too large' as const };
  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length) return { error: 'File content is required' as const };
  if (buffer.length > MAX_IMPORT_BYTES) return { error: 'File is too large' as const };
  return {
    buffer,
    filename: String(body.filename ?? ''),
    mimeType: String(body.mimeType ?? ''),
  };
}

async function loadActiveSalonClients(salonId: string): Promise<
  { error: string } | { rows: ClientImportExisting[] }
> {
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, email, phone, notes, birthday')
    .eq('salon_id', salonId)
    .is('deleted_at', null);

  if (error) return { error: error.message };
  return {
    rows: (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email ?? '',
      phone: row.phone ?? '',
      notes: row.notes ?? '',
      birthday: row.birthday ?? null,
    })),
  };
}

function draftsFromBody(body: { rows?: unknown }): ClientImportDraft[] {
  const incoming = Array.isArray(body.rows) ? body.rows : [];
  return incoming.map((row) => sanitizeClientDraft((row ?? {}) as Record<string, unknown>));
}

router.post('/import/parse', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const decoded = decodeBase64File(req.body ?? {});
  if ('error' in decoded) return res.status(400).json({ error: decoded.error });
  const name = decoded.filename.toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
    return res.status(400).json({ error: 'Upload an .xlsx, .xls, or .csv file' });
  }
  try {
    const drafts = parseClientSpreadsheetBuffer(decoded.buffer);
    const loaded = await loadActiveSalonClients(salonId);
    if ('error' in loaded) return res.status(500).json({ error: loaded.error });
    res.json({ source: 'excel', rows: planImportClients(loaded.rows, drafts) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not parse spreadsheet';
    return res.status(400).json({ error: message });
  }
});

router.post('/import/preview', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const drafts = draftsFromBody(req.body ?? {});
  const loaded = await loadActiveSalonClients(salonId);
  if ('error' in loaded) return res.status(500).json({ error: loaded.error });
  res.json({ rows: planImportClients(loaded.rows, drafts) });
});

router.post('/import/commit', requireSalonWriteAccess, async (req, res) => {
  const salonId = getSalonId(req);
  const drafts = draftsFromBody(req.body ?? {});
  const loaded = await loadActiveSalonClients(salonId);
  if ('error' in loaded) return res.status(500).json({ error: loaded.error });

  const working = loaded.rows.map((row) => ({ ...row }));
  const result = emptyImportResult();

  for (const raw of drafts) {
    const draft = sanitizeClientDraft(raw);
    if (!draftHasContent(draft) || !draft.name) {
      result.skipped += 1;
      continue;
    }

    const planned = planImportClients(working, [draft])[0];
    if (!planned || planned.action === 'skip') {
      result.skipped += 1;
      continue;
    }

    if (planned.action === 'reuse' && planned.existingClientId) {
      const current = working.find((row) => row.id === planned.existingClientId);
      if (!current) {
        result.errors.push({ name: draft.name, message: 'Client not found' });
        continue;
      }
      const updates = reuseFillUpdates(current, draft);
      if (Object.keys(updates).length === 0) {
        result.reused += 1;
        continue;
      }
      const { data, error } = await supabase
        .from('clients')
        .update(updates)
        .eq('id', current.id)
        .eq('salon_id', salonId)
        .is('deleted_at', null)
        .select('id')
        .single();
      if (error || !data) {
        result.errors.push({ name: draft.name, message: error?.message || 'Update failed' });
        continue;
      }
      Object.assign(current, updates);
      result.updated += 1;
      continue;
    }

    const built = buildClientCreateRow(
      {
        name: draft.name,
        email: draft.email,
        phone: draft.phone,
        notes: draft.notes,
        birthday: draft.birthday,
      },
      salonId
    );
    if ('error' in built) {
      result.errors.push({ name: draft.name, message: built.error });
      continue;
    }

    const { data, error } = await supabase
      .from('clients')
      .insert(built.row)
      .select('id, name, email, phone, notes, birthday')
      .single();

    if (error || !data) {
      result.errors.push({ name: draft.name, message: error?.message || 'Create failed' });
      continue;
    }

    working.push({
      id: data.id,
      name: data.name,
      email: data.email ?? '',
      phone: data.phone ?? '',
      notes: data.notes ?? '',
      birthday: data.birthday ?? null,
    });
    result.created += 1;
  }

  res.json(result);
});

export default router;
