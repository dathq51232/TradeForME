-- User management for admins: list every user, change roles, lock and unlock sign-in, delete an account.
-- Each action is written to audit_log. An admin cannot demote, lock or delete themselves (so there is always
-- an admin left), and must demote another admin before locking or deleting them.
--
-- Who starts as admin: private.admin_emails holds the SHA-256 of their email address (lower case), so this public
-- repository never shows the address. Such a user is made admin now if they already have an account, or when
-- they sign up. Add one more with:
--   insert into private.admin_emails values (encode(extensions.digest(lower('name@example.com'), 'sha256'), 'hex'));

create table private.admin_emails (email_sha256 text primary key check (email_sha256 ~ '^[0-9a-f]{64}$'));
insert into private.admin_emails values ('d5b1ddedcf482176b7cda74cc62fffc7a45ff9446f51cde2089cbaa08e8589e8');

create or replace function private.listed_admin(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.admin_emails
                 where email_sha256 = encode(extensions.digest(lower(coalesce(p_email, '')), 'sha256'), 'hex'));
$$;

-- profiles are created by handle_new_user() when someone signs up; a listed address becomes admin right there
create or replace function private.promote_listed_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.listed_admin((select email from auth.users where id = new.id)) then new.role := 'admin'; end if;
  return new;
end $$;
create trigger profiles_listed_admin before insert on public.profiles
  for each row execute function private.promote_listed_admin();

update public.profiles p set role = 'admin'
from auth.users u where u.id = p.id and private.listed_admin(u.email) and p.role <> 'admin';

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function private.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ admin mới làm được việc này' using errcode = '42501'; end if;
end $$;

-- Every user with what an admin needs to manage them (no secrets: no tokens, no password data).
create or replace function public.admin_list_users()
returns table (id uuid, email text, full_name text, role text, created_at timestamptz, last_sign_in_at timestamptz,
               locked boolean, telegram boolean, mt5_accounts int, radar_alerts boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform private.require_admin();
  return query
  select u.id, u.email::text, p.full_name, coalesce(p.role, 'user'), u.created_at, u.last_sign_in_at,
         coalesce(u.banned_until > now(), false), coalesce(p.telegram_chat_id, '') <> '',
         (select count(*)::int from public.mt5_accounts m where m.owner_id = u.id),
         coalesce((select r.alerts_on from public.radar_settings r where r.user_id = u.id), false)
  from auth.users u left join public.profiles p on p.id = u.id
  order by u.created_at desc;
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  perform private.require_admin();
  if p_role not in ('admin', 'manager', 'user') then raise exception 'Quyền không hợp lệ: %', p_role using errcode = '22023'; end if;
  if p_user = auth.uid() and p_role <> 'admin' then
    raise exception 'Bạn không thể tự hạ quyền admin của mình' using errcode = '42501';
  end if;
  select role into v_old from public.profiles where id = p_user;
  if v_old is null then raise exception 'Không tìm thấy người dùng' using errcode = 'P0002'; end if;
  update public.profiles set role = p_role where id = p_user;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'admin.set_role', p_user::text, jsonb_build_object('from', v_old, 'to', p_role));
end $$;

-- Locking bans sign-in (banned_until) and ends the user's sessions, so they are out once their current token
-- expires (at most an hour). Unlocking lets them sign in again.
create or replace function public.admin_set_locked(p_user uuid, p_locked boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if p_user = auth.uid() then raise exception 'Bạn không thể tự khoá tài khoản của mình' using errcode = '42501'; end if;
  if p_locked and exists (select 1 from public.profiles where id = p_user and role = 'admin') then
    raise exception 'Hạ quyền admin của người này trước khi khoá' using errcode = '42501';
  end if;
  -- a date far ahead, not 'infinity': Supabase Auth reads this column into a Go time, which has no infinity
  update auth.users set banned_until = case when p_locked then now() + interval '100 years' else null end where id = p_user;
  if not found then raise exception 'Không tìm thấy người dùng' using errcode = 'P0002'; end if;
  if p_locked and to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = $1' using p_user;
  end if;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), case when p_locked then 'admin.lock' else 'admin.unlock' end, p_user::text, null);
end $$;

-- Deletes the account and everything that belongs to it (profiles cascade to layouts, alerts, MT5 accounts...).
-- The admin must type the user's email to confirm.
create or replace function public.admin_delete_user(p_user uuid, p_confirm_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  perform private.require_admin();
  if p_user = auth.uid() then raise exception 'Bạn không thể tự xoá tài khoản của mình' using errcode = '42501'; end if;
  select email into v_email from auth.users where id = p_user;
  if v_email is null then raise exception 'Không tìm thấy người dùng' using errcode = 'P0002'; end if;
  if exists (select 1 from public.profiles where id = p_user and role = 'admin') then
    raise exception 'Hạ quyền admin của người này trước khi xoá' using errcode = '42501';
  end if;
  if lower(trim(coalesce(p_confirm_email, ''))) <> lower(v_email) then
    raise exception 'Email xác nhận không khớp' using errcode = '22023';
  end if;
  delete from auth.users where id = p_user;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'admin.delete_user', p_user::text, jsonb_build_object('email', v_email));
end $$;

revoke all on function public.admin_list_users, public.admin_set_role, public.admin_set_locked, public.admin_delete_user
  from public, anon;
grant execute on function public.is_admin, public.admin_list_users, public.admin_set_role, public.admin_set_locked,
  public.admin_delete_user to authenticated;
revoke all on function private.listed_admin, private.promote_listed_admin, private.require_admin from public, anon, authenticated;
