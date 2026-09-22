import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
export function database({queueMigration=true}={}) {
  const sql = new DatabaseSync(':memory:');
  for (const name of readdirSync('migrations').filter(n=>n.endsWith('.sql') && (queueMigration || (!n.startsWith('0005') && !n.startsWith('0012')))).sort()) sql.exec(readFileSync(`migrations/${name}`,'utf8'));
  function statement(query, values=[]) {
    return {
      bind(...args) { return statement(query,args); },
      async first() { return sql.prepare(query).get(...values) ?? null; },
      async all() { return {results:sql.prepare(query).all(...values)}; },
      async run() { const result=sql.prepare(query).run(...values);return {meta:{changes:Number(result.changes)}}; },
    };
  }
  return {sql,env:{DB:{prepare:statement,async batch(statements) {
    sql.exec('BEGIN');
    try { const result=[];for(const s of statements) result.push(await s.run());sql.exec('COMMIT');return result; }
    catch(error) {sql.exec('ROLLBACK');throw error;}
  }},TELEGRAM_BOT_TOKEN:'fake-test-token',TELEGRAM_CHAT_ID:'123'}};
}
