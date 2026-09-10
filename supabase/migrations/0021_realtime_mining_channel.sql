-- 0021 — private per-user Realtime channel for live mining events (M16B)
--
-- NOT an economic change. No table, column, trigger or row of the economic
-- schema is touched. This only authorises browsers to receive ephemeral
-- broadcast messages on their own private topic.
--
-- Realtime Authorization: a client that joins a channel with
-- `config: { private: true }` is checked against RLS policies on
-- `realtime.messages`. `realtime.topic()` is the channel name being joined;
-- `extension = 'broadcast'` restricts the grant to broadcast messages.
-- The policy below lets an authenticated user receive on exactly
-- `mining:<their own auth.uid()>` and nothing else. No policy grants INSERT,
-- so browsers cannot publish; the server publishes with the service role
-- over the REST broadcast endpoint, which is not subject to these policies.
--
-- Live events carry no economic authority: they are copies of persisted
-- values or labelled estimates, and the dashboard reconciles from the
-- database after every event.

begin;

create policy "own mining channel: receive broadcasts"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) = 'mining:' || (select auth.uid())::text
  );

commit;

-- ROLLBACK:
--   drop policy if exists "own mining channel: receive broadcasts" on realtime.messages;
