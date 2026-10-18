-- Denkmodus je KI-Agent: null = wie das KI-Profil, 'off' = aus, 'on' = an (überschreibt das Profil)
alter table users add column thinking_mode text check (thinking_mode in ('off','on'));
