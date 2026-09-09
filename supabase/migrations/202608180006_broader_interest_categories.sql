-- The conversation-first product is not limited to business news. These
-- categories allow a user-owned brief to keep permanent state for local and
-- personal-interest changes without mislabelling them as infrastructure.
alter type public.event_category add value if not exists 'business';
alter type public.event_category add value if not exists 'local';
alter type public.event_category add value if not exists 'personal_interest';

