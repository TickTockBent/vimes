import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

describe('better-sqlite3 :memory: smoke test', () => {
  it('sets WAL pragma and round-trips a row', () => {
    const inMemoryDatabase = new Database(':memory:');

    expect(() => inMemoryDatabase.pragma('journal_mode = WAL')).not.toThrow();

    inMemoryDatabase.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    inMemoryDatabase.prepare('INSERT INTO widgets (name) VALUES (?)').run('gasket');

    const insertedRow = inMemoryDatabase
      .prepare('SELECT name FROM widgets WHERE name = ?')
      .get('gasket') as { name: string } | undefined;

    expect(insertedRow?.name).toBe('gasket');

    inMemoryDatabase.close();
  });
});
