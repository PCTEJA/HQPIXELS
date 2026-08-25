-- =============================================================================
-- HQPixels 0005 — pricing and occupancy, computed in the database
-- =============================================================================

-- -----------------------------------------------------------------------------
-- quote_total_cents
-- -----------------------------------------------------------------------------
-- The authoritative price. Deliberately a second, independent implementation of
-- shared/pricing.ts: the reservation RPC compares this number against the one
-- the Worker computed and aborts on any disagreement. A price-tampering bug
-- would have to exist identically in TypeScript and PL/pgSQL to get through.
--
-- Integer arithmetic only. `/` on bigint truncates toward zero in PostgreSQL,
-- which matches Math.floor() for the non-negative values involved, so the
-- half-up rounding `(base * bp + 5000) / 10000` is bit-identical to the
-- TypeScript version.
create or replace function public.quote_total_cents(
  p_pricing_version_id uuid,
  p_x integer,
  p_y integer,
  p_w integer,
  p_h integer
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cpp integer;
  v_zones jsonb;
  v_min_cells integer;
  v_max_cells integer;
  v_base bigint;
  v_total bigint := 0;
  v_cx integer;
  v_cy integer;
  v_bp integer;
  v_zone jsonb;
begin
  -- Geometry first: never do arithmetic on an unvalidated rectangle.
  if p_x is null or p_y is null or p_w is null or p_h is null then
    raise exception 'bad_dimensions' using errcode = '22023';
  end if;
  if p_x < 0 or p_y < 0 or p_w < 1 or p_h < 1 then
    raise exception 'bad_dimensions' using errcode = '22023';
  end if;
  if p_x + p_w > 100 or p_y + p_h > 100 then
    raise exception 'out_of_bounds' using errcode = '22003';
  end if;

  select pv.cents_per_logical_pixel, pv.zone_multipliers, pv.min_cells, pv.max_cells
    into v_cpp, v_zones, v_min_cells, v_max_cells
  from public.pricing_versions pv
  where pv.id = p_pricing_version_id;

  if v_cpp is null then
    raise exception 'pricing_version_not_found' using errcode = 'P0002';
  end if;

  if (p_w * p_h) < v_min_cells then
    raise exception 'too_small' using errcode = '22023';
  end if;
  if (p_w * p_h) > least(v_max_cells, 2500) then
    raise exception 'too_large' using errcode = '22023';
  end if;

  -- 100 logical pixels per cell.
  v_base := v_cpp::bigint * 100;

  for v_cy in p_y .. (p_y + p_h - 1) loop
    for v_cx in p_x .. (p_x + p_w - 1) loop
      v_bp := 10000;

      -- First matching zone wins. Array order is part of the pricing version.
      for v_zone in select jsonb_array_elements(v_zones) loop
        if v_cx >= (v_zone ->> 'x')::integer
           and v_cx < (v_zone ->> 'x')::integer + (v_zone ->> 'w')::integer
           and v_cy >= (v_zone ->> 'y')::integer
           and v_cy < (v_zone ->> 'y')::integer + (v_zone ->> 'h')::integer
        then
          v_bp := (v_zone ->> 'multiplierBp')::integer;
          exit;
        end if;
      end loop;

      v_total := v_total + ((v_base * v_bp + 5000) / 10000);
    end loop;
  end loop;

  if v_total <= 0 or v_total > 100000000 then
    raise exception 'quote_out_of_range' using errcode = '22003';
  end if;

  return v_total::integer;
end;
$$;

revoke all on function public.quote_total_cents(uuid, integer, integer, integer, integer) from public;
grant execute on function public.quote_total_cents(uuid, integer, integer, integer, integer)
  to service_role;

comment on function public.quote_total_cents(uuid, integer, integer, integer, integer) is
  'Authoritative price in integer cents. Independent reimplementation of '
  'shared/pricing.ts; reserve_cells() cross-checks the two.';

-- -----------------------------------------------------------------------------
-- active_pricing_version
-- -----------------------------------------------------------------------------
create or replace function public.active_pricing_version()
returns public.pricing_versions
language sql
stable
security definer
set search_path = ''
as $$
  select pv.* from public.pricing_versions pv where pv.is_active limit 1;
$$;

revoke all on function public.active_pricing_version() from public;
grant execute on function public.active_pricing_version() to service_role;

-- -----------------------------------------------------------------------------
-- occupancy_bitmap
-- -----------------------------------------------------------------------------
-- 10,000 cells packed into 1,250 bytes, row-major, LSB-first within each byte.
-- Byte-for-byte identical layout to shared/occupancy.ts, which
-- supabase/tests/02_reservations.sql and tests/unit/occupancy.test.ts both pin.
--
-- Implemented with set_byte over a zero-filled bytea rather than string
-- concatenation, so it is a single pass over the claimed cells.
create or replace function public.occupancy_bitmap()
returns bytea
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_map bytea := decode(repeat('00', 1250), 'hex');
  v_row record;
  v_index integer;
  v_byte_index integer;
begin
  for v_row in
    select c.cell_x, c.cell_y from public.pixel_cells c
  loop
    v_index := v_row.cell_y * 100 + v_row.cell_x;
    v_byte_index := v_index / 8;
    v_map := set_byte(
      v_map,
      v_byte_index,
      get_byte(v_map, v_byte_index) | (1 << (v_index % 8))
    );
  end loop;
  return v_map;
end;
$$;

revoke all on function public.occupancy_bitmap() from public;
grant execute on function public.occupancy_bitmap() to service_role;

comment on function public.occupancy_bitmap() is
  'Packed availability bitmap for the wall manifest. Layout must match '
  'shared/occupancy.ts: index = y*100 + x, byte = index>>3, bit = index&7.';

-- -----------------------------------------------------------------------------
-- rect_available
-- -----------------------------------------------------------------------------
-- Read-only availability probe for the quote endpoint. NOT a reservation
-- guarantee: between this call and reserve_cells() another buyer may win the
-- race, which is exactly why reserve_cells() relies on the primary key rather
-- than on this result.
create or replace function public.rect_unavailable_cells(
  p_x integer, p_y integer, p_w integer, p_h integer, p_limit integer default 50
)
returns table (cell_x integer, cell_y integer)
language sql
stable
security definer
set search_path = ''
as $$
  select c.cell_x, c.cell_y
  from public.pixel_cells c
  where c.cell_x >= p_x and c.cell_x < p_x + p_w
    and c.cell_y >= p_y and c.cell_y < p_y + p_h
  order by c.cell_y, c.cell_x
  limit least(greatest(p_limit, 1), 2500);
$$;

revoke all on function public.rect_unavailable_cells(integer, integer, integer, integer, integer)
  from public;
grant execute on function public.rect_unavailable_cells(integer, integer, integer, integer, integer)
  to service_role;
