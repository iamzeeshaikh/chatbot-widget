-- Member / user management for the ZeeOps chatbot admin dashboards.
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- There are TWO separate dashboards ("workspaces"): 'sports' and 'packaging'.
-- Every member belongs to exactly one workspace and can never see the other.
-- Members are backed by Supabase Auth (auth.users). ADMIN members see every
-- site in their workspace; STANDARD members see only their assigned_sites.
-- The built-in logins (sports@/packaging@zeeops.dev) are workspace admins and
-- do NOT live in this table.

create table if not exists public.members (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  workspace     text not null check (workspace in ('sports', 'packaging')),
  role          text not null check (role in ('admin', 'standard')),
  assigned_sites text[] not null default '{}',
  created_at    timestamptz not null default now()
);

-- The dashboard talks to Supabase exclusively through the service-role key
-- (server-side), so RLS is enabled with no public policies: the service role
-- bypasses RLS and the anon key can never read this table.
alter table public.members enable row level security;

create index if not exists members_workspace_idx on public.members (workspace);
