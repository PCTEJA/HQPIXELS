-- Owner-requested release uses the same reservation lock as checkout/payment.
create or replace function public.cancel_reservation(p_reservation_id uuid, p_owner_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_res public.reservations;
begin
  select * into v_res from public.reservations
  where id = p_reservation_id and owner_id = p_owner_id for update;
  if v_res.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_res.state = 'expired' then
    return jsonb_build_object('ok', true, 'cellsReleased', 0);
  end if;
  -- Open Stripe sessions must expire before inventory can be relinquished.
  if v_res.state not in ('draft', 'reserved', 'ready_for_checkout') or exists (
    select 1 from public.payments where reservation_id = v_res.id
    and status not in ('failed', 'canceled')
  ) then
    return jsonb_build_object('ok', false, 'code', 'reservation_state_invalid');
  end if;
  return public.release_reservation(v_res.id, 'expired', 'hold removed by owner');
end;
$$;
revoke all on function public.cancel_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_reservation(uuid, uuid) to service_role;
