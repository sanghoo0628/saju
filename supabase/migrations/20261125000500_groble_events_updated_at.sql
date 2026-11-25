-- 20261125000100 is already applied to saju-dev: preserve that migration byte-for-byte.
-- Historical transition times are unknown; initialize old rows from their creation time.
alter table private.groble_events add column updated_at timestamptz;
update private.groble_events set updated_at=created_at;
alter table private.groble_events alter column updated_at set default now();
alter table private.groble_events alter column updated_at set not null;

-- A replay writing the same state/order must not erase the last real transition time.
create trigger groble_events_set_updated_at
  before update of state,order_id on private.groble_events
  for each row
  when (old.state is distinct from new.state or old.order_id is distinct from new.order_id)
  execute function private.set_updated_at();
