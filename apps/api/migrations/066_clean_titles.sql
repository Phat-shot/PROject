-- Titel mit vorangestellter eigener Kennung („AGP-0: Termin …“, von Modellen erzeugt) bereinigen; neue Titel bereinigt cleanTitle
update tasks t set title = regexp_replace(t.title, '^' || p.key || '-\d+\s*[–:-]\s*', '')
  from projects p where p.id = t.project_id and t.title ~ ('^' || p.key || '-\d+\s*[–:-]\s*\S');
