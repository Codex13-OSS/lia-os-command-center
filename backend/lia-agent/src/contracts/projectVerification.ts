export type ProjectVerificationExecutable = "npm" | "node" | "npx";

export type ProjectVerificationCheck = {
  id: string;
  executable: ProjectVerificationExecutable;
  args: string[];
  timeoutMs: number;
};

export type ProjectVerificationProfile = {
  projectId: string;
  checks: ProjectVerificationCheck[];
};

export type ProjectVerificationRegistry = {
  resolve(projectId: string): ProjectVerificationProfile | undefined;
};
