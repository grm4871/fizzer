export interface LocalNetdoc {
  id: string;
  name: string;
  content: string;
  can_edit: number;
  last_synced: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalNetdocVersion {
  id: string;
  netdoc_id: string;
  content: string;
  title: string;
  author: string;
  created_at: string;
}

export interface ElectronAPI {
  getConfig: () => Promise<{ success: boolean; config?: { db_path: string }; error?: string }>;
  updateDbPath: (newPath: string) => Promise<{ success: boolean; error?: string }>;
  getConfigDir: () => Promise<{ success: boolean; configDir?: string; error?: string }>;

  // Netdoc operations
  netdocExists: (id: string) => Promise<{ success: boolean; exists?: boolean; error?: string }>;
  getNetdoc: (id: string) => Promise<{ success: boolean; netdoc?: LocalNetdoc | null; error?: string }>;
  saveNetdoc: (params: { id: string; name: string; content: string; canWrite: boolean }) => Promise<{ success: boolean; netdoc?: LocalNetdoc; error?: string }>;
  updateNetdocContent: (params: { id: string; name: string; content: string }) => Promise<{ success: boolean; updated?: boolean; error?: string }>;
  deleteNetdoc: (id: string) => Promise<{ success: boolean; deleted?: boolean; error?: string }>;
  getNetdocVersions: (netdocId: string) => Promise<{ success: boolean; versions?: LocalNetdocVersion[]; error?: string }>;
  saveNetdocVersion: (params: { id: string; netdocId: string; content: string; title: string; author: string }) => Promise<{ success: boolean; error?: string }>;
  getLatestVersionContent: (netdocId: string) => Promise<{ success: boolean; content?: string | null; error?: string }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
