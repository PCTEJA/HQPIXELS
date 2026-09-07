\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cancel-test@example.com', now(), '{}');
do $$
declare
  v jsonb;
  rid uuid;
begin
  v := public.reserve_cells('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 90, 90, 1, 1, 1, 1000, 1000, '{"lines":[]}', 'v1');
  if not (v->>'ok')::boolean then raise exception 'reserve failed: %', v; end if;
  rid := (v->'reservation'->>'id')::uuid;
  v := public.cancel_reservation(rid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if v->>'code' <> 'not_found' then raise exception 'ownership bypass'; end if;
  if not exists(select 1 from public.pixel_cells where reservation_id = rid) then raise exception 'unauthorized release'; end if;
  v := public.cancel_reservation(rid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  if not (v->>'ok')::boolean or (v->>'cellsReleased')::int <> 1 then raise exception 'release failed: %', v; end if;
  if exists(select 1 from public.pixel_cells where reservation_id = rid) then raise exception 'cells still held'; end if;
  v := public.cancel_reservation(rid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  if not (v->>'ok')::boolean then raise exception 'retry failed'; end if;
  v := public.reserve_cells('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 90, 90, 1, 1, 1, 1000, 1000, '{"lines":[]}', 'v1');
  if not (v->>'ok')::boolean then raise exception 'cannot reclaim released plot: %', v; end if;
end;
$$;
rollback;
