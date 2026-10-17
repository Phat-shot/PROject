-- Benachrichtigungen per Mail: Zeitpunkt des Versands je Meldung (sofort oder im Tages-Digest)
alter table notifications add column mailed_at timestamptz;
create index notifications_unmailed_idx on notifications(user_id) where mailed_at is null and read_at is null;
