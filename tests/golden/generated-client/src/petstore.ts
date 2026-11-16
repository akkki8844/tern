// Shape of a generated SDK: one exported function per operation.
export async function getPetById(petId: number): Promise<unknown> {
  return request("GET", `/pets/${petId}`);
}

export async function uploadFile(petId: number, body: unknown): Promise<unknown> {
  return request("POST", `/pets/${petId}/images`, body);
}

declare function request(method: string, path: string, body?: unknown): Promise<unknown>;
