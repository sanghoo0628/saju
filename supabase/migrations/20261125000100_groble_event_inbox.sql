-- Server-only durable inbox. No live activation; apply separately after B review.
create table private.groble_events (
  event_id text primary key,
  transaction_id text not null,
  event_type text not null check (event_type in ('payment.completed','payment.cancel_requested','payment.refunded')),
  occurred_at timestamptz not null,
  payload_hash text not null,
  state text not null default 'pending_mapping' check (state in ('pending_mapping','applied','review_required')),
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now()
);
create index groble_events_transaction_idx on private.groble_events(transaction_id);
create table private.groble_deliveries (
  idempotency_key text primary key,
  event_id text not null references private.groble_events(event_id) on delete restrict
);
create table private.groble_refunds (
  business_key text primary key,
  transaction_id text not null,
  amount integer not null check (amount between 1 and 500),
  partial_refund boolean not null,
  refunded_at timestamptz not null
);
create index groble_refunds_transaction_idx on private.groble_refunds(transaction_id);
alter table private.groble_events enable row level security;
alter table private.groble_deliveries enable row level security;
alter table private.groble_refunds enable row level security;
revoke all on private.groble_events, private.groble_deliveries, private.groble_refunds from public,anon,authenticated;
grant select,insert,update on private.groble_events to service_role;
grant select,insert on private.groble_deliveries,private.groble_refunds to service_role;
