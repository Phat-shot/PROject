export interface IncomingMessage {
  folder: string;
  uid: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  from: { address: string; name: string | null };
  to: string[];
  cc: string[];
  subject: string;
  date: Date;
  text: string | null;
  html: string | null;
  hasAttachments: boolean;
}

/** Header-Teil ohne Body: reicht für Absender-, Empfänger-, Betreff- und Datumsfilter. */
export type MessageEnvelope = Omit<IncomingMessage, 'text' | 'html' | 'hasAttachments'>;

export interface OutgoingMessage {
  from: { address: string; name?: string | null };
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface AccountRow {
  id: string;
  org_id: string;
  /** Spiegel des Verwalters (eine Version lang); Bindungen stehen in mail_account_uses */
  type: 'personal' | 'project' | 'org';
  owner_user_id: string | null;
  project_id: string | null;
  managed_user_id?: string | null;
  managed_project_id?: string | null;
  name: string;
  address: string;
  provider: 'imap' | 'dev' | 'graph';
  /** OAuth2-Konto (Microsoft 365 oder Google): Zugriffstoken wird vor jedem Zugriff aufgefrischt */
  oauth_provider?: 'microsoft' | 'google' | null;
  oauth_refresh_token?: string | null;
  oauth_access_token?: string | null;
  oauth_expires_at?: Date | string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_user: string | null;
  imap_password: string | null;
  imap_secure: boolean | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_password: string | null;
  smtp_secure: boolean | null;
  sync_cursor: Record<string, unknown>;
}

export interface SyncContext {
  /** Ordner, die mindestens eine Ansicht nennt (INBOX, wenn keine Angabe). */
  folders: string[];
  /** Prüft Kopfdaten; nur Treffer werden vollständig geladen. */
  headerMatches: (env: MessageEnvelope) => boolean;
  /** Ob mindestens eine Ansicht einen Stichwortfilter auf den Text hat. */
  needsBody: boolean;
}

export interface MailProvider {
  /** Liefert neue Nachrichten ab Cursor; lädt Bodies nur für Treffer. */
  fetchNew(account: AccountRow, ctx: SyncContext): Promise<{ messages: IncomingMessage[]; cursor: Record<string, unknown> }>;
  send(account: AccountRow, msg: OutgoingMessage): Promise<{ messageId: string }>;
  /** Ordner des Kontos (inkl. Spezialordner) */
  listFolders(account: AccountRow): Promise<MailFolder[]>;
  createFolder(account: AccountRow, path: string): Promise<MailFolder>;
  /** Nachricht in anderen Ordner verschieben; liefert die neue UID, falls bekannt */
  move(account: AccountRow, mail: { folder: string; uid: string | null }, target: string): Promise<{ uid: string | null }>;
}

export interface MailFolder {
  path: string;
  name: string;
  specialUse: 'inbox' | 'sent' | 'trash' | 'archive' | 'drafts' | 'junk' | null;
}
