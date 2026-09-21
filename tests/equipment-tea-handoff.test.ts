import test from 'node:test';
import assert from 'node:assert/strict';
import { EQUIPMENT_CONFIGURATIONS, buildTechnoEconomicHandoff } from '../src/services/workspace/equipment-selector';
import {
  queueEquipmentHandoff, consumePendingEquipmentHandoff, createInMemoryStoreForTests, type KeyValueStore,
} from '../src/services/workspace/equipment-tea-handoff';

function freshStore(): KeyValueStore {
  return createInMemoryStoreForTests();
}

// ---------- real, deterministic handoff round-trip (item 2 of the fix spec) ----------

test('queueEquipmentHandoff -> consumePendingEquipmentHandoff: round-trips the exact technical parameters, with an importedAt timestamp', () => {
  const store = freshStore();
  const handoff = buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]);
  queueEquipmentHandoff(handoff, store);
  const record = consumePendingEquipmentHandoff(store);
  assert.ok(record);
  assert.deepEqual(record?.handoff, handoff);
  assert.ok(record?.importedAt);
  assert.ok(!Number.isNaN(Date.parse(record!.importedAt)));
});

test('consumePendingEquipmentHandoff: consumed exactly once - a second call after consuming returns null, never re-applying the same handoff', () => {
  const store = freshStore();
  queueEquipmentHandoff(buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]), store);
  assert.ok(consumePendingEquipmentHandoff(store));
  assert.equal(consumePendingEquipmentHandoff(store), null);
});

test('consumePendingEquipmentHandoff: nothing queued yet returns null, never throws', () => {
  const store = freshStore();
  assert.equal(consumePendingEquipmentHandoff(store), null);
});

// ---------- repeated/duplicate handoff never corrupts state (item 2: "duplicate/repeated handoff") ----------

test('a repeated handoff of the SAME configuration simply overwrites the pending slot - no accumulation, no crash', () => {
  const store = freshStore();
  const handoff = buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]);
  queueEquipmentHandoff(handoff, store);
  queueEquipmentHandoff(handoff, store);
  queueEquipmentHandoff(handoff, store);
  const record = consumePendingEquipmentHandoff(store);
  assert.ok(record);
  assert.equal(consumePendingEquipmentHandoff(store), null, 'only one pending record must ever exist, regardless of how many times it was queued');
});

test('a handoff for a DIFFERENT configuration overwrites an earlier unread one - the user always gets the LAST thing they explicitly chose', () => {
  const store = freshStore();
  const first = buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]);
  const second = buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[1]);
  queueEquipmentHandoff(first, store);
  queueEquipmentHandoff(second, store);
  const record = consumePendingEquipmentHandoff(store);
  assert.equal(record?.handoff.configurationId, second.configurationId);
});

// ---------- no fabricated financial data (item 2: "не придумывать CAPEX/OPEX/стоимость") ----------

test('the handoff object never contains any financial/cost field - only technical parameters that genuinely exist on the configuration', () => {
  const handoff = buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]);
  const keys = Object.keys(handoff);
  for (const forbidden of ['capex', 'opex', 'cost', 'price', 'equipmentCost', 'capitalCost']) {
    assert.ok(!keys.some(k => k.toLocaleLowerCase().includes(forbidden.toLocaleLowerCase())), `handoff must not contain a "${forbidden}"-like field`);
  }
  assert.ok(handoff.note.includes('не рассчитывается автоматически'));
});

// ---------- storage unavailable / malformed data never crash the app ----------

test('queueEquipmentHandoff/consumePendingEquipmentHandoff: a null store (storage genuinely unavailable) is a safe no-op', () => {
  const handoff = buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]);
  assert.doesNotThrow(() => queueEquipmentHandoff(handoff, null));
  assert.equal(consumePendingEquipmentHandoff(null), null);
});

test('consumePendingEquipmentHandoff: malformed/corrupted stored JSON is safely ignored, never crashes', () => {
  const store = freshStore();
  store.setItem('plasmatech.equipment-tea-handoff.v1', 'not json at all');
  assert.equal(consumePendingEquipmentHandoff(store), null);

  const store2 = freshStore();
  store2.setItem('plasmatech.equipment-tea-handoff.v1', JSON.stringify({ unrelated: true }));
  assert.equal(consumePendingEquipmentHandoff(store2), null);
});
