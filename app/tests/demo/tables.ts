// Reading a sandbox's data straight from the database, for the vitest and
// the browser tests alike. Not a test file, and free of any test framework:
// both runners import it.
//
// "A sandbox's data" is every row in any table that names the sandbox. The
// tables are listed from the schema at run time, never from a fixed list, so
// a table added later is covered: every column in the public schema whose
// type is uuid, text or character varying is a column that may hold a
// sandbox ID, and a row names the sandbox when one of those columns equals
// its ID.

import pg from 'pg';

export type Column = { table: string; column: string };

// The tables the schema held when these tests were written. The listing must
// reach every one of them, so a listing that finds nothing cannot pass.
export const KNOWN_TABLES = [
  'sandboxes',
  'structured_data',
  'snapshots',
  'drafts',
  'turns',
  'gaps',
  'gap_members',
  'usage_sandbox',
  'replays',
] as const;

let pool: pg.Pool | null = null;

export function sql(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; these tests read the database');
  pool ??= new pg.Pool({ connectionString: url, max: 3, allowExitOnIdle: true });
  return pool;
}

export async function closeSql(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

// Every column that may hold a sandbox ID.
export async function idColumns(): Promise<Column[]> {
  const { rows } = await sql().query(
    `select table_name as table, column_name as column
       from information_schema.columns c
       join information_schema.tables t using (table_schema, table_name)
      where c.table_schema = 'public'
        and t.table_type = 'BASE TABLE'
        and c.data_type in ('uuid', 'text', 'character varying')
        and c.table_name not like '\\_\\_%'
      order by table_name, column_name`,
  );
  return rows as Column[];
}

// The tables the listing reached.
export function tablesOf(columns: Column[]): string[] {
  return [...new Set(columns.map((c) => c.table))].sort();
}

// Each column that holds rows naming the sandbox, with how many: empty when
// no row in any table names it.
export async function rowsNaming(id: string, columns?: Column[]): Promise<string[]> {
  const found: string[] = [];
  for (const c of columns ?? (await idColumns())) {
    const { rows } = await sql().query(`select count(*)::int as n from ${quote(c.table)} where ${quote(c.column)}::text = $1`, [id]);
    if (rows[0].n > 0) found.push(`${c.table}.${c.column}: ${rows[0].n} row(s)`);
  }
  return found;
}

// Every row naming the sandbox, table by table, as comparable JSON. `omit`
// leaves out columns whose change is not a change to the demo data.
export async function rowsOf(id: string, omit: string[] = []): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const c of await idColumns()) {
    const { rows } = await sql().query(
      `select to_jsonb(t) as row from ${quote(c.table)} t where ${quote(c.column)}::text = $1 order by to_jsonb(t)::text`,
      [id],
    );
    if (rows.length === 0) continue;
    out[`${c.table}.${c.column}`] = rows.map((r) => {
      const row = { ...(r.row as Record<string, unknown>) };
      for (const k of omit) delete row[k];
      return row;
    });
  }
  return out;
}

// How many rows in the whole database hold `text` in any text or jsonb
// column: a marker a test wrote into one sandbox only.
export async function rowsHolding(text: string): Promise<string[]> {
  const { rows: columns } = await sql().query(
    `select table_name as table, column_name as column
       from information_schema.columns c
       join information_schema.tables t using (table_schema, table_name)
      where c.table_schema = 'public'
        and t.table_type = 'BASE TABLE'
        and c.data_type in ('text', 'character varying', 'jsonb', 'json')
        and c.table_name not like '\\_\\_%'`,
  );
  const found: string[] = [];
  for (const c of columns as Column[]) {
    const { rows } = await sql().query(`select count(*)::int as n from ${quote(c.table)} where strpos(${quote(c.column)}::text, $1) > 0`, [text]);
    if (rows[0].n > 0) found.push(`${c.table}.${c.column}: ${rows[0].n} row(s)`);
  }
  return found;
}

// The sandbox's last activity, from sandboxes.last_seen_at, or null when the
// sandbox is gone.
export async function lastSeen(id: string): Promise<Date | null> {
  const { rows } = await sql().query('select last_seen_at from sandboxes where id = $1', [id]);
  return rows.length ? (rows[0].last_seen_at as Date) : null;
}

export async function setLastSeen(id: string, at: Date): Promise<void> {
  const { rowCount } = await sql().query('update sandboxes set last_seen_at = $2 where id = $1', [id, at]);
  if (rowCount !== 1) throw new Error(`no sandbox ${id} to date`);
}

// Triggers that make every write naming one sandbox fail, in every table the
// listing finds, as a database failing mid-request would. Returns how to
// remove them.
export async function failWritesFor(id: string, boom: string): Promise<() => Promise<void>> {
  const columns = await idColumns();
  const name = `demo_fail_${Array.from({ length: 12 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
  const byTable = new Map<string, string[]>();
  for (const c of columns) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c.column]);
  const created: string[] = [];
  for (const [table, cols] of byTable) {
    const fn = `${name}_${created.length}`;
    const test = (rec: 'old' | 'new') => cols.map((col) => `${rec}.${quote(col)}::text = '${id}'`).join(' or ');
    await sql().query(`
      create function ${fn}() returns trigger language plpgsql as $$
      begin
        if (tg_op <> 'INSERT' and (${test('old')})) or (tg_op <> 'DELETE' and (${test('new')})) then
          raise exception '${boom} % on ${table}', tg_op;
        end if;
        return coalesce(new, old);
      end $$`);
    await sql().query(`create trigger ${fn} before insert or update or delete on ${quote(table)} for each row execute function ${fn}()`);
    created.push(`${quote(table)}|${fn}`);
  }
  return async () => {
    for (const entry of created) {
      const [table, fn] = entry.split('|');
      await sql().query(`drop trigger if exists ${fn} on ${table}`);
      await sql().query(`drop function if exists ${fn}()`);
    }
  };
}
