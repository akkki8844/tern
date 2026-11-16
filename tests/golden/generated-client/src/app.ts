import { getPetById, uploadFile } from "./petstore.js";

export async function showPet(id: number) {
  return getPetById(id);
}

export async function attachPhoto(id: number, data: unknown) {
  return uploadFile(id, data);
}
