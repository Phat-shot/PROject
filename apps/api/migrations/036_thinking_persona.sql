-- KI-Profil: Denkmodus abschaltbar (lokale Modelle mit Thinking, z. B. Qwen); KI-Agent: Persona als Beschreibung des Schreibstils
alter table ai_profiles add column thinking_off boolean not null default false;
alter table users add column persona text;
