-- Planungstiefe je Projekt: auto (Regel Aufgabe vs. Checklistenpunkt), aufgaben (Schritte immer als Aufgaben), checkliste (immer Checklistenpunkte)
alter table projects add column planning_depth text not null default 'auto' check (planning_depth in ('auto', 'aufgaben', 'checkliste'));
