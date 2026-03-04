import { openDB } from 'idb';

const DB_NAME = 'mot-pwa-db';
const VERSION = 1;
let _db = null;

async function getDB() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('masterScripts'))
        db.createObjectStore('masterScripts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('trialLogs')) {
        const s = db.createObjectStore('trialLogs', { keyPath: 'trial_id' });
        s.createIndex('timestamp', 'timestamp');
      }
    },
  });
  return _db;
}

export const saveMasterScript   = async (id, data) =>
  (await getDB()).put('masterScripts', { id, data, savedAt: Date.now() });
export const loadMasterScript   = async (id) => {
  const rec = await (await getDB()).get('masterScripts', id);
  return rec?.data ?? null;
};
export const countMasterScripts = async () => (await getDB()).count('masterScripts');
export const clearMasterScripts = async () => (await getDB()).clear('masterScripts');
export const saveTrialLog       = async (row) => (await getDB()).put('trialLogs', row);
export const getAllTrialLogs     = async ()    => (await getDB()).getAll('trialLogs');
export const clearTrialLogs     = async ()    => (await getDB()).clear('trialLogs');
