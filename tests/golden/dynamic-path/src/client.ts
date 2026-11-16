declare const API_BASE: string | undefined;

const API = API_BASE ?? "https://api.example.com";

export async function getSession(token: string, key: string): Promise<unknown> {
  const res = await fetch(`${API}/sessions/${token}/${key}`);
  return res.json();
}
