-- Überholte Meldungen (neuere zum selben Arbeitspaket, Arbeitspaket erledigt, kein wartender Entwurf mehr): gelesen und ausgeblendet
alter table notifications add column superseded_at timestamptz;
