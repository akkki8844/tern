const BASE = "https://api.example.com";

export async function httpGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}
