import { http } from "@acme/http";

export async function deleteUser(id: string) {
  return http.delete(`/users/${id}`);
}
