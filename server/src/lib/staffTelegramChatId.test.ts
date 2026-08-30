import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapStaff } from './mappers.ts';
import {
  isMissingStaffTelegramChatIdColumn,
  mapStaffTelegramChatId,
  parseStaffTelegramChatIdBody,
  persistStaffTelegramChatId,
  STAFF_TELEGRAM_CHAT_ID_UNAVAILABLE,
} from './staffTelegramChatId.ts';

const FULL_ID = '8355947762';

function staffRow(telegramChatId: string | number | null = null) {
  return {
    id: 'staff-1',
    name: 'Tatev',
    email: 'tatev@example.com',
    phone: '',
    role: 'Stylist',
    specialties: ['Color'],
    avatar: 'TM',
    active: true,
    is_primary: true,
    telegram_chat_id: telegramChatId,
  };
}

function memoryStaffDb(initial: { telegram_chat_id: string | number | null } = { telegram_chat_id: null }) {
  const row = { ...staffRow(initial.telegram_chat_id) };
  const lastUpdate: Record<string, unknown>[] = [];
  return {
    row,
    lastUpdate,
    from(table: string) {
      assert.equal(table, 'staff');
      return {
        update(patch: Record<string, unknown>) {
          lastUpdate.push(patch);
          if (Object.prototype.hasOwnProperty.call(patch, 'telegram_chat_id')) {
            row.telegram_chat_id = patch.telegram_chat_id as string | null;
          }
          const chain: any = {
            eq() {
              return chain;
            },
            select() {
              return {
                maybeSingle: async () => ({
                  data: { telegram_chat_id: row.telegram_chat_id },
                  error: null,
                }),
                single: async () => ({ data: { ...row }, error: null }),
              };
            },
          };
          return chain;
        },
        select() {
          const chain: any = {
            eq() {
              return chain;
            },
            maybeSingle: async () => ({ data: { ...row }, error: null }),
            single: async () => ({ data: { ...row }, error: null }),
          };
          return chain;
        },
      };
    },
  };
}

describe('staff telegram_chat_id save/load', () => {
  it('update 8355947762 is in the write payload, API response, and subsequent read', async () => {
    const parsed = parseStaffTelegramChatIdBody({ telegramChatId: FULL_ID });
    assert.equal(parsed.provided, true);
    assert.equal(parsed.ok, true);
    if (!parsed.provided || !parsed.ok) throw new Error('expected parsed id');
    assert.equal(parsed.value, FULL_ID);
    assert.notEqual(parsed.value, String(Number.parseInt(FULL_ID, 10) | 0));

    const db = memoryStaffDb();
    const updatePatch = { name: 'Tatev', telegram_chat_id: parsed.value };
    const updated = await db.from('staff').update(updatePatch).eq('id', 'staff-1').select('*').single();
    assert.deepEqual(db.lastUpdate[0], updatePatch);
    assert.equal(updated.data.telegram_chat_id, FULL_ID);

    const apiResponse = mapStaff(updated.data, ['svc-1']);
    assert.equal(apiResponse.telegramChatId, FULL_ID);
    assert.equal(apiResponse.serviceIds?.join(','), 'svc-1');
    assert.deepEqual(apiResponse.specialties, ['Color']);

    const reread = await db.from('staff').select('*').eq('id', 'staff-1').maybeSingle();
    assert.equal(mapStaffTelegramChatId(reread.data.telegram_chat_id), FULL_ID);
    assert.equal(mapStaff(reread.data).telegramChatId, FULL_ID);

    const persisted = await persistStaffTelegramChatId({
      db,
      salonId: 'salon-1',
      staffId: 'staff-1',
      value: FULL_ID,
    });
    assert.equal(persisted.ok, true);
    if (persisted.ok) assert.equal(persisted.telegramChatId, FULL_ID);
  });

  it('missing telegram_chat_id column is reported, not treated as a successful save', async () => {
    const missing = {
      from() {
        return {
          update() {
            const chain: any = {
              eq() {
                return chain;
              },
              select() {
                return {
                  maybeSingle: async () => ({
                    data: null,
                    error: {
                      message:
                        "Could not find the 'telegram_chat_id' column of 'staff' in the schema cache",
                    },
                  }),
                };
              },
            };
            return chain;
          },
        };
      },
    };
    const result = await persistStaffTelegramChatId({
      db: missing,
      salonId: 'salon-1',
      staffId: 'staff-1',
      value: FULL_ID,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.missingColumn, true);
      assert.equal(result.message, STAFF_TELEGRAM_CHAT_ID_UNAVAILABLE);
    }
    assert.equal(
      isMissingStaffTelegramChatIdColumn({
        message: "Could not find the 'telegram_chat_id' column of 'staff' in the schema cache",
      }),
      true
    );
  });
});
