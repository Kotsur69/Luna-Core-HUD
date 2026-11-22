-- A new pairing request is always fresh: no backdated created_at (to sort
-- ahead of a real request) and no pre-set nonces or status. The host also
-- rejects such rows (src/hostpairing.js).
create or replace function public.host_pairings_fresh() returns trigger
  language plpgsql set search_path = '' as $$
begin
  new.created_at := now();
  new.status := 'pending';
  new.host_nonce := null;
  new.phone_nonce := null;
  return new;
end;
$$;

drop trigger if exists host_pairings_fresh on public.host_pairings;
create trigger host_pairings_fresh before insert on public.host_pairings
  for each row execute function public.host_pairings_fresh();
