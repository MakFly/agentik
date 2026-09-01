import { homedir } from "node:os";
import { join } from "node:path";

export function agentikHome(override?: string): string {
  return override || process.env.AGENTIK_HOME || join(homedir(), ".agentik");
}

export function memoryPaths(home: string) {
  return {
    root: home,
    memoryDir: join(home, "memory"),
    hot: join(home, "memory", "MEMORY.md"),
    user: join(home, "memory", "USER.md"),
    db: join(home, "memory", "notes.sqlite"),
    pendingSkills: join(home, "pending", "skills"),
    skills: join(home, "skills"),
  };
}
