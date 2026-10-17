-- SSO: Berechtigungsgruppen aus dem Identitätsanbieter (Gruppen-Claim) auf eigene Gruppen abbilden
alter table groups add column idp_name text;
