import type { Project } from "./services/projects";

export type AuthKind = "key" | "session";

/** Variabel yang disetel middleware auth pada context Hono. */
export interface AppEnv {
  Variables: {
    project: Project;
    authKind: AuthKind;
  };
}
