import { afterEach,expect,it } from 'vitest';
import { database } from './db-harness';

let sql;
afterEach(()=>sql?.close());

it('uses bounded indexes for the feed timeline and sent-delivery sample',()=>{
  ({sql}=database());
  const feedPlan=sql.prepare(`EXPLAIN QUERY PLAN SELECT * FROM feed_items
    ORDER BY COALESCE(published_at,created_at) DESC,id DESC LIMIT 31`).all()
    .map(row=>row.detail).join(' ');
  expect(feedPlan).toContain('idx_feed_effective_timeline');
  expect(feedPlan).not.toContain('USE TEMP B-TREE');

  const outboxPlan=sql.prepare(`EXPLAIN QUERY PLAN SELECT first_seen_at,published_at,sent_at
    FROM telegram_outbox WHERE source_ref IS NOT NULL AND status='sent'
    ORDER BY first_seen_at DESC LIMIT 500`).all()
    .map(row=>row.detail).join(' ');
  expect(outboxPlan).toContain('idx_outbox_sent_seen');
  expect(outboxPlan).not.toContain('USE TEMP B-TREE');
});
