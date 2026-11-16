const ROUTES: Record<string, string> = {
  widget: "/widgets",
  gadget: "/gadgets"
};

export async function load(kind: string, id: string): Promise<unknown> {
  // Path only exists at runtime — the scanner must stay honest.
  const res = await fetch(`${ROUTES[kind]}/${id}`);
  return res.json();
}
