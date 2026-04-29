import { queryOne } from "../db/client.ts";

interface WorkspaceProfileRow {
  store_name: string | null;
  store_description: string | null;
  store_url: string | null;
}

export async function getStoreProfile(workspaceId: number): Promise<string | null> {
  const row = await queryOne<WorkspaceProfileRow>(
    "SELECT store_name, store_description, store_url FROM workspaces WHERE id = $1",
    [workspaceId],
  );

  if (!row) return null;

  const parts: string[] = [];
  if (row.store_name) parts.push(`STORE: ${row.store_name}`);
  if (row.store_description) parts.push(`ABOUT: ${row.store_description}`);
  if (row.store_url) parts.push(`URL: ${row.store_url}`);

  return parts.length > 0 ? parts.join("\n") : null;
}
