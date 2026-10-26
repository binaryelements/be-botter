import { createContext, useContext } from "react";

/** False while only admins add connections and this person is not one; the API enforces it. */
export const ConnectionsAccess = createContext(true);

export function useCanManageConnections(): boolean {
  return useContext(ConnectionsAccess);
}
